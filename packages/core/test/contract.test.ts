import { describe, it, expect, afterEach } from "vitest";
import type {
  ChatRequest,
  ChatStreamEvent,
  EngineCapabilities,
  InferenceEngine,
} from "@ew/shared";
import { EasyWorkClient } from "@ew/sdk";
import { createCore, type CoreServer } from "../src/index.js";

/** 消费 /v1/chat/completions 的 OpenAI 风格 SSE，拼回文本。 */
async function streamV1(baseUrl: string, token: string, model: string): Promise<{ text: string; done: boolean }> {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], stream: true }),
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let text = "";
  let done = false;
  for (;;) {
    const { value, done: rdDone } = await reader.read();
    if (rdDone) break;
    buf += dec.decode(value, { stream: true });
    const frames = buf.split("\n\n");
    buf = frames.pop() ?? "";
    for (const f of frames) {
      const line = f.replace(/^data: /, "").trim();
      if (!line) continue;
      if (line === "[DONE]") {
        done = true;
        continue;
      }
      const obj = JSON.parse(line) as { choices?: { delta?: { content?: string } }[] };
      const delta = obj.choices?.[0]?.delta?.content;
      if (delta) text += delta;
    }
  }
  return { text, done };
}

/** 一个不依赖 node-llama-cpp 的假引擎，用于端到端贯通测试。 */
class FakeEngine implements InferenceEngine {
  readonly id = "fake";
  readonly capabilities: EngineCapabilities = {
    streaming: true,
    nativeToolCalls: false,
    vision: false,
    audio: false,
    embeddings: false,
    jsonSchema: false,
  };

  async chat(req: ChatRequest) {
    return {
      message: { role: "assistant" as const, content: "hi" },
      finishReason: "stop" as const,
      model: req.model,
    };
  }

  async *chatStream(_req: ChatRequest): AsyncIterable<ChatStreamEvent> {
    for (const t of ["Hello", ", ", "world", "!"]) {
      yield { type: "text-delta", text: t };
    }
    yield {
      type: "done",
      finishReason: "stop",
      message: { role: "assistant", content: "Hello, world!" },
    };
  }
}

describe("daemon end-to-end (SDK → core → engine)", () => {
  let core: CoreServer | undefined;

  afterEach(async () => {
    await core?.stop();
    core = undefined;
  });

  it("streams chat through the OpenAI-compatible /v1 gateway", async () => {
    core = createCore({ token: "test-token" });
    const fake = new FakeEngine();
    core.registry.register(fake);
    core.registry.routeModel("fake-model", fake);

    const { port, host } = await core.start({ port: 0, host: "127.0.0.1" });
    const baseUrl = `http://${host}:${port}`;
    const client = new EasyWorkClient({ baseUrl, token: "test-token" });

    const health = await client.health();
    expect(health.ok).toBe(true);

    const models = await client.listModels();
    expect(models.routed).toContain("fake-model");

    const { text, done } = await streamV1(baseUrl, "test-token", "fake-model");
    expect(text).toBe("Hello, world!");
    expect(done).toBe(true);
  });

  it("rejects unauthorized requests", async () => {
    core = createCore({ token: "secret" });
    const { port, host } = await core.start({ port: 0, host: "127.0.0.1" });
    const bad = new EasyWorkClient({ baseUrl: `http://${host}:${port}`, token: "wrong" });
    await expect(bad.listModels()).rejects.toThrow();
  });

  it("returns 404 for unloaded model on /v1", async () => {
    core = createCore({ token: "t" });
    const { port, host } = await core.start({ port: 0, host: "127.0.0.1" });
    const res = await fetch(`http://${host}:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ model: "nope", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(404);
  });
});
