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

interface ModelsResponseShape {
  data: Array<{ id: string }>;
}

interface ChatCompletionResponseShape {
  object: string;
  choices: Array<{ message: { content?: string } }>;
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

describe("/v1 OpenAI 兼容端点（经云端 provider）", () => {
  let core: CoreServer | undefined;
  afterEach(async () => {
    await core?.stop();
    core = undefined;
  });

  // 注：云端「流式」现走 pi-ai（统一 ModelRegistry/AuthStorage），用 fake fetch 无法拦截 pi 的 HTTP，
  // 其流式覆盖见 openai-local-proxy.test（fake cloudStream）。这里验证 /v1/models + 非流式（仍经引擎）。
  it("addProvider 后 /v1/models 列出模型，/v1/chat/completions 非流式经引擎可用", async () => {
    core = createCore({ token: "t", fetch: fakeUpstream });
    core.providers.add({ id: "cloud", baseUrl: "http://upstream.test/v1", models: ["cloud-model"] });
    const { port, host } = await core.start({ port: 0, host: "127.0.0.1" });
    const base = `http://${host}:${port}`;
    const auth = { authorization: "Bearer t", "content-type": "application/json" };

    // /v1/models
    const modelsRes = await fetch(`${base}/v1/models`, { headers: { authorization: "Bearer t" } });
    const modelsJson = (await modelsRes.json()) as ModelsResponseShape;
    expect(modelsJson.data.map((m) => m.id)).toContain("cloud-model");

    // 非流式（云端非流式仍走引擎 → fake 上游）
    const jsonRes = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ model: "cloud-model", messages: [{ role: "user", content: "hi" }] }),
    });
    const j = (await jsonRes.json()) as ChatCompletionResponseShape;
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
