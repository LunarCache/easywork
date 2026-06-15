import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { EngineRegistry } from "../engine/registry.js";
import {
  chatResponseToOpenAI,
  openaiToChatRequest,
  streamEventToOpenAIChunks,
} from "./translate.js";
import {
  anthropicToChatRequest,
  chatResponseToAnthropic,
  AnthropicStreamTranslator,
  type AnthropicRequestBody,
} from "./anthropic.js";

let counter = 0;
function genId(): string {
  counter += 1;
  return `chatcmpl-${Date.now().toString(36)}${counter.toString(36)}`;
}

/** 网关依赖：本地已加载模型的 llama-server baseUrl 解析器（用于本地透传）。 */
export interface OpenAICompatDeps {
  /** 返回已加载本地模型的 OpenAI/Anthropic 兼容 baseUrl（http://host:port/v1）；非本地返回 undefined。 */
  localBaseUrl?: (model: string) => string | undefined;
  /** 透传所用 fetch（默认全局；测试可注入）。 */
  fetch?: typeof fetch;
}

/**
 * 本地透传：把请求反向代理到该模型的 llama-server（原生支持 OpenAI /chat/completions
 * 与 Anthropic /messages，且我们带 --jinja 启动）。原样转发 + 回流，不经我们的翻译层。
 */
async function proxyToLocal(
  base: string,
  path: string,
  req: FastifyRequest,
  reply: FastifyReply,
  fetchImpl: typeof fetch,
): Promise<void> {
  const ac = new AbortController();
  reply.raw.on("close", () => ac.abort());
  let upstream: Response;
  try {
    upstream = await fetchImpl(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req.body ?? {}),
      signal: ac.signal,
    });
  } catch (err) {
    if (!reply.sent) reply.code(502).send({ error: { message: `local upstream error: ${String(err)}` } });
    return;
  }
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") ?? "application/json",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "access-control-allow-origin": req.headers.origin ?? "*",
  });
  if (!upstream.body) {
    raw.end();
    return;
  }
  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      raw.write(Buffer.from(value));
    }
  } catch {
    /* 客户端断开/上游中断：直接收尾 */
  } finally {
    raw.end();
  }
}

/**
 * 挂载 OpenAI 兼容端点，复用同一 EngineRegistry。
 * 让外部工具（Claude Code / openai SDK）指向 http://127.0.0.1:<port>/v1 即可用。
 * 本地已加载模型直接透传到其 llama-server；云端走引擎（Step 2 改 pi-ai）。
 */
export function registerOpenAICompat(
  app: FastifyInstance,
  registry: EngineRegistry,
  deps: OpenAICompatDeps = {},
): void {
  app.get("/v1/models", async () => ({
    object: "list",
    data: registry.routedModels().map((id) => ({
      id,
      object: "model",
      created: 0,
      owned_by: "easywork",
    })),
  }));

  app.post("/v1/chat/completions", async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    const model = typeof body.model === "string" ? body.model : "";
    // 本地已加载模型 → 透传到 llama-server 原生 /v1/chat/completions。
    const localBase = model ? deps.localBaseUrl?.(model) : undefined;
    if (localBase) return proxyToLocal(localBase, "/chat/completions", req, reply, deps.fetch ?? fetch);

    const chatReq = openaiToChatRequest(body);
    if (!chatReq.model) return reply.code(400).send({ error: { message: "missing model" } });

    let engine;
    try {
      engine = registry.resolve(chatReq.model);
    } catch {
      return reply.code(404).send({ error: { message: `model not found: ${chatReq.model}` } });
    }

    const id = genId();
    const created = Math.floor(Date.now() / 1000);
    const stream = body.stream === true;

    if (!stream) {
      const res = await engine.chat(chatReq);
      return chatResponseToOpenAI(res, id, created);
    }

    const ac = new AbortController();
    reply.raw.on("close", () => ac.abort());
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": req.headers.origin ?? "*",
    });
    const roleSent = { value: false };
    try {
      for await (const ev of engine.chatStream({ ...chatReq, signal: ac.signal })) {
        for (const chunk of streamEventToOpenAIChunks(ev, { id, created, model: chatReq.model, roleSent })) {
          raw.write(`data: ${chunk}\n\n`);
        }
      }
    } catch (err) {
      raw.write(
        `data: ${JSON.stringify({ error: { message: err instanceof Error ? err.message : String(err) } })}\n\n`,
      );
    } finally {
      raw.write("data: [DONE]\n\n");
      raw.end();
    }
  });

  // ---- Anthropic Messages API 兼容（让走 Anthropic 协议的客户端，如 Claude Code，可接入）----
  app.post("/v1/messages", async (req, reply) => {
    const body = req.body as AnthropicRequestBody;
    // 本地已加载模型 → 透传到 llama-server 原生 /v1/messages（含 tool_use，需 --jinja，已带）。
    const localBase = body.model ? deps.localBaseUrl?.(body.model) : undefined;
    if (localBase) return proxyToLocal(localBase, "/messages", req, reply, deps.fetch ?? fetch);

    const chatReq = anthropicToChatRequest(body);
    if (!chatReq.model) return reply.code(400).send({ type: "error", error: { message: "missing model" } });
    let engine;
    try {
      engine = registry.resolve(chatReq.model);
    } catch {
      return reply.code(404).send({ type: "error", error: { message: `model not found: ${chatReq.model}` } });
    }
    const id = `msg_${Date.now().toString(36)}${(counter += 1).toString(36)}`;

    if (body.stream !== true) {
      const res = await engine.chat(chatReq);
      return chatResponseToAnthropic(res, id, chatReq.model);
    }

    const ac = new AbortController();
    reply.raw.on("close", () => ac.abort());
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": req.headers.origin ?? "*",
    });
    const tr = new AnthropicStreamTranslator(id, chatReq.model);
    raw.write(tr.start());
    try {
      for await (const ev of engine.chatStream({ ...chatReq, signal: ac.signal })) {
        const frame = tr.event(ev);
        if (frame) raw.write(frame);
      }
      raw.write(tr.end());
    } catch (err) {
      raw.write(
        `event: error\ndata: ${JSON.stringify({ type: "error", error: { message: err instanceof Error ? err.message : String(err) } })}\n\n`,
      );
    } finally {
      raw.end();
    }
  });

  app.post("/v1/embeddings", async (req, reply) => {
    const body = req.body as { model?: string; input?: string | string[] };
    if (!body.model) return reply.code(400).send({ error: { message: "missing model" } });
    let engine;
    try {
      engine = registry.resolve(body.model);
    } catch {
      return reply.code(404).send({ error: { message: `model not found: ${body.model}` } });
    }
    if (!engine.embed) return reply.code(400).send({ error: { message: "engine has no embeddings" } });
    const input = Array.isArray(body.input) ? body.input : [body.input ?? ""];
    const result = await engine.embed({ model: body.model, input });
    return {
      object: "list",
      model: result.model,
      data: result.vectors.map((embedding, index) => ({ object: "embedding", index, embedding })),
      usage: { prompt_tokens: 0, total_tokens: 0 },
    };
  });
}
