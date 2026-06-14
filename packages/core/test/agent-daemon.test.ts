import { describe, it, expect, afterEach } from "vitest";
import type { AgentEvent } from "@ew/shared";
import { createCore, type CoreServer } from "../src/index.js";

const enc = new TextEncoder();
function sse(frames: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(`data: ${f}\n\n`));
      c.enqueue(enc.encode("data: [DONE]\n\n"));
      c.close();
    },
  });
  return new Response(stream, { status: 200 });
}

/** 假云端：第一次返回 calculator 的 tool_call，第二次返回最终答案。 */
function makeUpstream(): typeof fetch {
  let call = 0;
  return (async (_input: RequestInfo | URL) => {
    call++;
    if (call === 1) {
      return sse([
        JSON.stringify({
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [{ index: 0, id: "c1", function: { name: "calculator", arguments: "" } }],
              },
            },
          ],
        }),
        JSON.stringify({
          choices: [
            { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"expression":"6*7"}' } }] } },
          ],
        }),
        JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
      ]);
    }
    return sse([
      JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "答案是 42。" } }] }),
      JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    ]);
  }) as unknown as typeof fetch;
}

async function collectAgentSSE(res: Response): Promise<AgentEvent[]> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const out: AgentEvent[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const line = buf.slice(0, idx).replace(/^data:\s?/, "");
      buf = buf.slice(idx + 2);
      if (line === "[DONE]" || !line.trim()) continue;
      out.push(JSON.parse(line) as AgentEvent);
    }
  }
  return out;
}

describe("/agent/run 端到端（云端原生 tool_call → 内置 calculator → 收尾）", () => {
  let core: CoreServer | undefined;
  afterEach(async () => {
    await core?.stop();
    core = undefined;
  });

  it("跑通工具调用循环并把结果喂回模型", async () => {
    core = createCore({ token: "t", fetch: makeUpstream(), skillsDirs: [] });
    core.providers.add({ id: "cloud", baseUrl: "http://up.test/v1", models: ["cloud-x"] });
    const { port, host } = await core.start({ port: 0, host: "127.0.0.1" });

    const res = await fetch(`http://${host}:${port}/agent/run`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({
        threadId: "x",
        model: "cloud-x",
        history: [{ role: "user", content: "6 乘 7 等于几？" }],
      }),
    });
    expect(res.status).toBe(200);

    const events = await collectAgentSSE(res);
    const toolStart = events.find((e) => e.type === "tool-start");
    expect(toolStart && (toolStart as any).call.name).toBe("calculator");
    const toolEnd = events.find((e) => e.type === "tool-end");
    expect(toolEnd && (toolEnd as any).result.content).toBe("42");
    const final = events.at(-1);
    expect(final?.type).toBe("final");
    expect((final as any).message.content).toBe("答案是 42。");
  });
});
