import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import type { EngineRegistry } from "../src/engine/registry.js";
import type { AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { registerOpenAICompat } from "../src/openai-compat/router.js";

/** 假 pi 流：把若干 AssistantMessageEvent 包成 AsyncIterable（router 只 for-await 它）。 */
function fakePiStream(events: AssistantMessageEvent[]): AssistantMessageEventStream {
  async function* gen(): AsyncGenerator<AssistantMessageEvent> {
    for (const e of events) yield e;
  }
  return gen() as unknown as AssistantMessageEventStream;
}

// Step 1：本地已加载模型 → /v1 透传到其 llama.cpp（不经我们的翻译层）。
const enc = new TextEncoder();
function sseResponse(frames: string[], contentType = "text/event-stream"): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(f));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": contentType } });
}

const stubRegistry = {
  routedModels: () => ["local-x"],
  resolve: () => {
    throw new Error("should not hit engine for local model");
  },
} as unknown as EngineRegistry;

describe("/v1 本地透传", () => {
  it("chat/completions: 本地模型反代到 llama.cpp /chat/completions，原样回流", async () => {
    let calledUrl = "";
    let calledBody = "";
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calledUrl = String(url);
      calledBody = String(init?.body ?? "");
      return sseResponse(["data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n", "data: [DONE]\n\n"]);
    }) as unknown as typeof fetch;

    const app = Fastify();
    registerOpenAICompat(app, stubRegistry, {
      localBaseUrl: (m) => (m === "local-x" ? "http://127.0.0.1:9999/v1" : undefined),
      fetch: fakeFetch,
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "local-x", messages: [{ role: "user", content: "yo" }], stream: true },
    });

    expect(calledUrl).toBe("http://127.0.0.1:9999/v1/chat/completions");
    expect(JSON.parse(calledBody).model).toBe("local-x");
    expect(res.body).toContain('"content":"hi"');
    expect(res.body).toContain("[DONE]");
    await app.close();
  });

  it("messages: 本地模型反代到 llama.cpp /messages（Anthropic 原生）", async () => {
    let calledUrl = "";
    const fakeFetch = (async (url: string | URL | Request) => {
      calledUrl = String(url);
      return sseResponse(["event: message_stop\ndata: {}\n\n"]);
    }) as unknown as typeof fetch;

    const app = Fastify();
    registerOpenAICompat(app, stubRegistry, {
      localBaseUrl: (m) => (m === "local-x" ? "http://127.0.0.1:9999/v1" : undefined),
      fetch: fakeFetch,
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      payload: { model: "local-x", messages: [{ role: "user", content: "yo" }], stream: true },
    });
    expect(calledUrl).toBe("http://127.0.0.1:9999/v1/messages");
    expect(res.body).toContain("message_stop");
    await app.close();
  });

  it("非本地模型不透传：localBaseUrl 返回 undefined → 走引擎路径（这里 resolve 抛错 → 404 流式错误体）", async () => {
    let fetched = false;
    const fakeFetch = (async () => {
      fetched = true;
      return new Response("");
    }) as unknown as typeof fetch;
    const app = Fastify();
    registerOpenAICompat(app, stubRegistry, { localBaseUrl: () => undefined, fetch: fakeFetch });
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "cloud-y", messages: [{ role: "user", content: "yo" }] },
    });
    expect(fetched).toBe(false); // 没有透传
    expect(res.statusCode).toBe(404); // 引擎 resolve 抛错 → 404
    await app.close();
  });
});

describe("/v1 云端经 pi-ai", () => {
  const piEvents: AssistantMessageEvent[] = [
    { type: "text_delta", contentIndex: 0, delta: "Hello", partial: {} } as AssistantMessageEvent,
    { type: "text_delta", contentIndex: 0, delta: " world", partial: {} } as AssistantMessageEvent,
    {
      type: "done",
      reason: "stop",
      message: { role: "assistant", content: [{ type: "text", text: "Hello world" }], usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: {} } },
    } as unknown as AssistantMessageEvent,
  ];

  it("chat/completions: 云端模型经 cloudStream → OpenAI chunks", async () => {
    let askedModel = "";
    const app = Fastify();
    registerOpenAICompat(app, stubRegistry, {
      localBaseUrl: () => undefined,
      cloudStream: async (modelId) => {
        askedModel = modelId;
        return modelId === "cloud-z" ? fakePiStream(piEvents) : null;
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "cloud-z", messages: [{ role: "user", content: "hi" }], stream: true },
    });
    expect(askedModel).toBe("cloud-z");
    expect(res.body).toContain("Hello");
    expect(res.body).toContain("world");
    expect(res.body).toContain("[DONE]");
    await app.close();
  });

  it("messages: 云端模型经 cloudStream → Anthropic 帧", async () => {
    const app = Fastify();
    registerOpenAICompat(app, stubRegistry, {
      localBaseUrl: () => undefined,
      cloudStream: async (modelId) => (modelId === "cloud-z" ? fakePiStream(piEvents) : null),
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      payload: { model: "cloud-z", messages: [{ role: "user", content: "hi" }], stream: true },
    });
    expect(res.body).toContain("message_start");
    expect(res.body).toContain("Hello");
    expect(res.body).toContain("message_stop");
    await app.close();
  });

  it("云端流中途出错：OpenAI 发 error 帧（不静默截断）", async () => {
    const errEvents = [
      { type: "text_delta", contentIndex: 0, delta: "partial", partial: {} },
      { type: "error", reason: "error", error: { errorMessage: "rate limited" } },
    ] as unknown as AssistantMessageEvent[];
    const app = Fastify();
    registerOpenAICompat(app, stubRegistry, { localBaseUrl: () => undefined, cloudStream: async () => fakePiStream(errEvents) });
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "cloud-z", messages: [{ role: "user", content: "hi" }], stream: true },
    });
    expect(res.body).toContain("rate limited");
    expect(res.body).toContain("upstream_error");
    await app.close();
  });

  it("云端流中途出错：Anthropic 发 error 事件且不伪装成 end_turn", async () => {
    const errEvents = [
      { type: "text_delta", contentIndex: 0, delta: "partial", partial: {} },
      { type: "error", reason: "error", error: { errorMessage: "boom" } },
    ] as unknown as AssistantMessageEvent[];
    const app = Fastify();
    registerOpenAICompat(app, stubRegistry, { localBaseUrl: () => undefined, cloudStream: async () => fakePiStream(errEvents) });
    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      payload: { model: "cloud-z", messages: [{ role: "user", content: "hi" }], stream: true },
    });
    expect(res.body).toContain("event: error");
    expect(res.body).toContain("boom");
    expect(res.body).not.toContain("end_turn");
    await app.close();
  });

  it("云端非流式：经 completeCloud → OpenAI 非流式 JSON", async () => {
    const msg = {
      role: "assistant",
      content: [{ type: "text", text: "from pi" }],
      model: "cloud-z",
      stopReason: "stop",
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: {} },
    } as unknown as AssistantMessage;
    const app = Fastify();
    registerOpenAICompat(app, stubRegistry, {
      localBaseUrl: () => undefined,
      completeCloud: async (m) => (m === "cloud-z" ? msg : null),
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "cloud-z", messages: [{ role: "user", content: "hi" }] },
    });
    const j = res.json() as { object: string; choices: { message: { content: string } }[] };
    expect(j.object).toBe("chat.completion");
    expect(j.choices[0]?.message.content).toBe("from pi");
    await app.close();
  });

  it("云端非流式：经 completeCloud → Anthropic 非流式 JSON", async () => {
    const msg = {
      role: "assistant",
      content: [{ type: "text", text: "from pi" }],
      model: "cloud-z",
      stopReason: "stop",
    } as unknown as AssistantMessage;
    const app = Fastify();
    registerOpenAICompat(app, stubRegistry, {
      localBaseUrl: () => undefined,
      completeCloud: async (m) => (m === "cloud-z" ? msg : null),
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      payload: { model: "cloud-z", messages: [{ role: "user", content: "hi" }] },
    });
    const j = res.json() as { type: string; content: { type: string; text: string }[] };
    expect(j.type).toBe("message");
    expect(j.content[0]?.text).toBe("from pi");
    await app.close();
  });

  it("cloudStream 返回 null（非云端）→ 回退引擎（stub 抛错 → 流式错误体）", async () => {
    const app = Fastify();
    registerOpenAICompat(app, stubRegistry, {
      localBaseUrl: () => undefined,
      cloudStream: async () => null,
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "other", messages: [{ role: "user", content: "hi" }], stream: true },
    });
    // 回退到引擎路径：stubRegistry.resolve 抛错 → 404（未命中云端透传）。
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
