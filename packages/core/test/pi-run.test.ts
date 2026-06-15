import { describe, it, expect } from "vitest";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AgentEvent } from "@ew/shared";
import { runAgentPi, type RunAgentPiDeps } from "../src/agent/pi/run-agent-pi.js";

const model = {
  id: "m",
  name: "m",
  api: "openai-completions" as const,
  provider: "local",
  baseUrl: "http://127.0.0.1:1/v1",
  reasoning: false,
  input: ["text" as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 1024,
};

const ZERO_USAGE = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** 假 streamFn：发 start→text_delta→done，回一条 assistant 消息（不调真实模型）。 */
const fakeStream = ((..._args: unknown[]) => {
  const s = new AssistantMessageEventStream();
  const msg = {
    role: "assistant",
    content: [{ type: "text", text: "Hello" }],
    api: "openai-completions",
    provider: "local",
    model: "m",
    usage: ZERO_USAGE,
    stopReason: "stop",
    timestamp: 0,
  };
  s.push({ type: "start", partial: msg });
  s.push({ type: "text_delta", contentIndex: 0, delta: "Hello", partial: msg });
  s.push({ type: "done", reason: "stop", message: msg });
  return s;
}) as unknown as RunAgentPiDeps["streamFn"];

async function collect(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe("runAgentPi", () => {
  it("跑通 pi loop（假 streamFn）→ 映射出 text / usage / final", async () => {
    const observed: { sessionId: string }[] = [];
    const deps: RunAgentPiDeps = {
      resolveModel: () => ({ model, apiKey: "x" }),
      tools: [],
      approval: { request: async () => "approve" },
      workspaceDir: "/tmp",
      streamFn: fakeStream,
      memory: {
        id: "m",
        recall: async () => [],
        write: async (i) => ({ id: "x", updatedAt: "", ...i }),
        edit: async () => ({ id: "x", layer: "agent-memory", text: "", updatedAt: "" }),
        list: async () => [],
        delete: async () => {},
        observe: async (i: { sessionId: string }) => {
          observed.push({ sessionId: i.sessionId });
        },
      },
    };
    const events = await collect(runAgentPi({ threadId: "t", model: "m", history: [{ role: "user", content: "hi" }] }, deps));
    const text = events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("");
    expect(text).toBe("Hello");
    expect(events.some((e) => e.type === "usage")).toBe(true);
    const final = events.at(-1);
    expect(final?.type).toBe("final");
    expect((final as { message: { content: string } }).message.content).toBe("Hello");
    expect(observed).toEqual([{ sessionId: "t" }]); // 收尾 observe 被调用
  });

  it("resolveModel 抛错 → error 事件", async () => {
    const deps: RunAgentPiDeps = {
      resolveModel: () => {
        throw new Error("无法解析模型");
      },
      tools: [],
      approval: { request: async () => "approve" },
      workspaceDir: "/tmp",
    };
    const events = await collect(runAgentPi({ threadId: "t", model: "x", history: [{ role: "user", content: "hi" }] }, deps));
    expect(events).toEqual([{ type: "error", message: "无法解析模型" }]);
  });
});
