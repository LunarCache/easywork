import { describe, it, expect, afterEach } from "vitest";
import { createCore, type CoreServer } from "../src/index.js";

const enc = new TextEncoder();

/** 构造一个上游 OpenAI 兼容的 SSE Response（供假 fetch 用）。 */
function sseResponse(frames: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(`data: ${f}\n\n`));
      controller.enqueue(enc.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

/** 假上游：模拟一个云端 OpenAI 兼容服务。 */
const fakeUpstream = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input.toString();
  const body = JSON.parse(String(init?.body ?? "{}"));
  if (url.endsWith("/chat/completions")) {
    if (body.stream) {
      return sseResponse([
        JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "cloud " } }] }),
        JSON.stringify({ choices: [{ index: 0, delta: { content: "reply" } }] }),
        JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
      ]);
    }
    return new Response(
      JSON.stringify({
        model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: "cloud says hi" }, finish_reason: "stop" }],
      }),
      { status: 200 },
    );
  }
  throw new Error(`unexpected upstream call: ${url}`);
}) as unknown as typeof fetch;

/** 解析 OpenAI SSE，拼接 delta.content。 */
async function collectOpenAIStream(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buffer = "";
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const line = buffer.slice(0, idx).replace(/^data:\s?/, "");
      buffer = buffer.slice(idx + 2);
      if (line === "[DONE]" || !line.trim()) continue;
      const chunk = JSON.parse(line);
      const c = chunk.choices?.[0]?.delta?.content;
      if (typeof c === "string") text += c;
    }
  }
  return text;
}

describe("/v1 OpenAI 兼容端点（经云端 provider）", () => {
  let core: CoreServer | undefined;
  afterEach(async () => {
    await core?.stop();
    core = undefined;
  });

  it("addProvider 后 /v1/models 列出模型，/v1/chat/completions 流式与非流式均可用", async () => {
    core = createCore({ token: "t", fetch: fakeUpstream });
    core.providers.add({ id: "cloud", baseUrl: "http://upstream.test/v1", models: ["cloud-model"] });
    const { port, host } = await core.start({ port: 0, host: "127.0.0.1" });
    const base = `http://${host}:${port}`;
    const auth = { authorization: "Bearer t", "content-type": "application/json" };

    // /v1/models
    const modelsRes = await fetch(`${base}/v1/models`, { headers: { authorization: "Bearer t" } });
    const modelsJson = (await modelsRes.json()) as any;
    expect(modelsJson.data.map((m: any) => m.id)).toContain("cloud-model");

    // 流式
    const streamRes = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ model: "cloud-model", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(await collectOpenAIStream(streamRes)).toBe("cloud reply");

    // 非流式
    const jsonRes = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ model: "cloud-model", messages: [{ role: "user", content: "hi" }] }),
    });
    const j = (await jsonRes.json()) as any;
    expect(j.choices[0].message.content).toBe("cloud says hi");
    expect(j.object).toBe("chat.completion");
  });

  it("/v1/chat/completions 未知模型返回 404", async () => {
    core = createCore({ token: "t", fetch: fakeUpstream });
    const { port, host } = await core.start({ port: 0, host: "127.0.0.1" });
    const res = await fetch(`http://${host}:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ model: "ghost", messages: [] }),
    });
    expect(res.status).toBe(404);
  });
});
