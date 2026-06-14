import { describe, it, expect, afterEach } from "vitest";
import type {
  ChatRequest,
  ChatStreamEvent,
  EngineCapabilities,
  InferenceEngine,
} from "@ew/shared";
import { EasyWorkClient } from "@ew/sdk";
import { createCore, type CoreServer } from "../src/index.js";

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

  it("streams chat events through the SDK", async () => {
    core = createCore({ token: "test-token" });
    const fake = new FakeEngine();
    core.registry.register(fake);
    core.registry.routeModel("fake-model", fake);

    const { port, host } = await core.start({ port: 0, host: "127.0.0.1" });
    const client = new EasyWorkClient({ baseUrl: `http://${host}:${port}`, token: "test-token" });

    const health = await client.health();
    expect(health.ok).toBe(true);

    const models = await client.listModels();
    expect(models.routed).toContain("fake-model");

    const events: ChatStreamEvent[] = [];
    for await (const ev of client.chatStream({
      model: "fake-model",
      messages: [{ role: "user", content: "hi" }],
    })) {
      events.push(ev);
    }

    const text = events
      .filter((e): e is Extract<ChatStreamEvent, { type: "text-delta" }> => e.type === "text-delta")
      .map((e) => e.text)
      .join("");
    expect(text).toBe("Hello, world!");
    expect(events.at(-1)?.type).toBe("done");
  });

  it("rejects unauthorized requests", async () => {
    core = createCore({ token: "secret" });
    const { port, host } = await core.start({ port: 0, host: "127.0.0.1" });
    const bad = new EasyWorkClient({ baseUrl: `http://${host}:${port}`, token: "wrong" });
    await expect(bad.listModels()).rejects.toThrow();
  });

  it("returns 404 for unloaded model", async () => {
    core = createCore({ token: "t" });
    const { port, host } = await core.start({ port: 0, host: "127.0.0.1" });
    const client = new EasyWorkClient({ baseUrl: `http://${host}:${port}`, token: "t" });
    await expect(
      (async () => {
        for await (const _ of client.chatStream({
          model: "nope",
          messages: [{ role: "user", content: "hi" }],
        })) {
          // drain
        }
      })(),
    ).rejects.toThrow();
  });
});
