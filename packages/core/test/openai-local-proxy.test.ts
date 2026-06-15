import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import type { EngineRegistry } from "../src/engine/registry.js";
import { registerOpenAICompat } from "../src/openai-compat/router.js";

// Step 1：本地已加载模型 → /v1 透传到其 llama-server（不经我们的翻译层）。
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
  it("chat/completions: 本地模型反代到 llama-server /chat/completions，原样回流", async () => {
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

  it("messages: 本地模型反代到 llama-server /messages（Anthropic 原生）", async () => {
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
