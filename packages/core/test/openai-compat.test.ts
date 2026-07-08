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

  // 云端推理路径走 pi-ai，fake fetch 无法拦截其内部 HTTP；推理覆盖见 openai-local-proxy.test。
  it("addProvider 后 /v1/models 列出模型", async () => {
    core = createCore({ token: "t", fetch: fakeUpstream });
    core.providers.add({
      id: "cloud",
      baseUrl: "http://upstream.test/v1",
      modelConfigs: [{ id: "cloud-model", contextWindow: 32768, inputModalities: ["text"] }],
    });
    const { port, host } = await core.start({ port: 0, host: "127.0.0.1" });
    const base = `http://${host}:${port}`;

    const modelsRes = await fetch(`${base}/v1/models`, { headers: { authorization: "Bearer t" } });
    const modelsJson = (await modelsRes.json()) as ModelsResponseShape;
    expect(modelsJson.data.map((m) => m.id)).toContain("cloud-model");
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

  it("pi-native provider models are exposed without registering an OpenAI-compatible engine", async () => {
    core = createCore({ token: "t", fetch: fakeUpstream });
    core.providers.add({
      id: "anthropic",
      kind: "pi-native",
      api: "anthropic-messages",
      apiKey: "sk-ant-test",
      modelConfigs: [{ id: "claude-haiku-4-5", contextWindow: 200000, inputModalities: ["text"] }],
    });
    const { port, host } = await core.start({ port: 0, host: "127.0.0.1" });
    const base = `http://${host}:${port}`;

    const models = await fetch(`${base}/models`, { headers: { authorization: "Bearer t" } }).then((r) => r.json() as Promise<{ routed: string[]; context: Record<string, number> }>);
    expect(models.routed).toContain("claude-haiku-4-5");
    expect(models.context["claude-haiku-4-5"]).toBe(200000);

    const v1 = await fetch(`${base}/v1/models`, { headers: { authorization: "Bearer t" } }).then((r) => r.json() as Promise<ModelsResponseShape>);
    expect(v1.data.map((m) => m.id)).toContain("claude-haiku-4-5");
  });
});
