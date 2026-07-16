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
import { chatRequestToPiContext, piEventToChatStreamEvents, newPiAdaptState, piAssistantToChatResponse } from "./pi-adapt.js";
import type { ChatRequest } from "@ew/shared";
import type { Context as PiContext, AssistantMessageEventStream, AssistantMessage } from "@earendil-works/pi-ai";
import { createGuardedStream, type GuardedStream } from "../server/guarded-stream.js";

let counter = 0;
function genId(): string {
  counter += 1;
  return `chatcmpl-${Date.now().toString(36)}${counter.toString(36)}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 网关依赖：本地已加载模型的 router baseUrl 解析器（用于本地透传）。 */
export interface OpenAICompatDeps {
  /** 返回已加载本地模型的 OpenAI/Anthropic 兼容 baseUrl（http://host:port/v1）；非本地返回 undefined。 */
  localBaseUrl?: (model: string) => string | undefined;
  /** 本地 router 的 --api-key（设置后透传需带 Bearer）；未设返回 undefined。 */
  localApiKey?: () => string | undefined;
  /** 透传所用 fetch（默认全局；测试可注入）。 */
  fetch?: typeof fetch;
  /** 云端流式经 pi-ai；非云端模型返回 null（回退到引擎）。 */
  cloudStream?: (
    modelId: string,
    context: PiContext,
    opts: { signal?: AbortSignal; temperature?: number; maxTokens?: number },
  ) => Promise<AssistantMessageEventStream | null>;
  /** 云端非流式经 pi-ai；非云端模型返回 null（回退到引擎）。 */
  completeCloud?: (
    modelId: string,
    context: PiContext,
    opts: { signal?: AbortSignal; temperature?: number; maxTokens?: number },
  ) => Promise<AssistantMessage | null>;
  /** 额外暴露的云端模型 id（例如 pi-native provider 不注册 EngineRegistry）。 */
  cloudModelIds?: () => string[];
}

type CloudCompleteResult =
  | { type: "miss" }
  | { type: "ok"; message: AssistantMessage }
  | { type: "error"; error: unknown };

/** 云端非流式 → pi-ai completeSimple；非云端返回 null（由调用方回退引擎）。 */
async function tryCompleteCloud(deps: OpenAICompatDeps, chatReq: ChatRequest): Promise<CloudCompleteResult> {
  if (!deps.completeCloud) return { type: "miss" };
  const knownCloudModel = deps.cloudModelIds?.().includes(chatReq.model) ?? false;
  try {
    const message = await deps.completeCloud(chatReq.model, chatRequestToPiContext(chatReq), {
      ...(chatReq.temperature != null ? { temperature: chatReq.temperature } : {}),
      ...(chatReq.maxTokens != null ? { maxTokens: chatReq.maxTokens } : {}),
    });
    return message ? { type: "ok", message } : { type: "miss" };
  } catch (error) {
    return knownCloudModel ? { type: "error", error } : { type: "miss" };
  }
}

/**
 * 本地透传：把请求反向代理到该模型的 router（原生支持 OpenAI /chat/completions
 * 与 Anthropic /messages，且我们带 --jinja 启动）。原样转发 + 回流，不经我们的翻译层。
 */
async function proxyToLocal(
  base: string,
  path: string,
  req: FastifyRequest,
  reply: FastifyReply,
  fetchImpl: typeof fetch,
  apiKey?: string,
): Promise<void> {
  const stream = createGuardedStream(reply);
  let upstream: Response;
  try {
    upstream = await fetchImpl(`${base}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(req.body ?? {}),
      signal: stream.signal,
    });
  } catch (err) {
    if (!reply.sent) reply.code(502).send({ error: { message: `local upstream error: ${String(err)}` } });
    return;
  }
  stream.open({
    status: upstream.status,
    contentType: upstream.headers.get("content-type") ?? "application/json",
    ...(req.headers.origin ? { origin: req.headers.origin } : {}),
  });
  try {
    if (upstream.body) {
      const reader = upstream.body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done || !stream.write(Buffer.from(value))) break;
      }
    }
  } catch {
    /* 客户端断开/上游中断：直接收尾 */
  } finally {
    stream.end();
  }
}

/**
 * 挂载 OpenAI 兼容端点，复用同一 EngineRegistry。
 * 让外部工具（Claude Code / openai SDK）指向 http://127.0.0.1:<port>/v1 即可用。
 * 本地已加载模型直接透传到其 router；云端走引擎（Step 2 改 pi-ai）。
 */
export function registerOpenAICompat(
  app: FastifyInstance,
  registry: EngineRegistry,
  deps: OpenAICompatDeps = {},
): void {
  app.get("/v1/models", async () => ({
    object: "list",
    data: [...new Set([...registry.routedModels(), ...(deps.cloudModelIds?.() ?? [])])].map((id) => ({
      id,
      object: "model",
      created: 0,
      owned_by: "easywork",
    })),
  }));

  app.post("/v1/chat/completions", async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    const model = typeof body.model === "string" ? body.model : "";
    // 本地已加载模型 → 透传到 router 原生 /v1/chat/completions。
    const localBase = model ? deps.localBaseUrl?.(model) : undefined;
    if (localBase) return proxyToLocal(localBase, "/chat/completions", req, reply, deps.fetch ?? fetch, deps.localApiKey?.());

    const chatReq = openaiToChatRequest(body);
    if (!chatReq.model) return reply.code(400).send({ error: { message: "missing model" } });
    let responseStream: GuardedStream | undefined;

    // 云端流式 → pi-ai（统一 ModelRegistry/AuthStorage，含 OAuth/Anthropic 原生）。非云端/出错 → 回退引擎。
    if (body.stream === true && deps.cloudStream) {
      responseStream = createGuardedStream(reply);
      let piStream: AssistantMessageEventStream | null = null;
      try {
        piStream = await deps.cloudStream(chatReq.model, chatRequestToPiContext(chatReq), {
          signal: responseStream.signal,
          ...(chatReq.temperature != null ? { temperature: chatReq.temperature } : {}),
          ...(chatReq.maxTokens != null ? { maxTokens: chatReq.maxTokens } : {}),
        });
      } catch {
        piStream = null; // cloudStream 抛错 → 回退引擎路径
      }
      if (piStream) {
        const id = genId();
        const created = Math.floor(Date.now() / 1000);
        responseStream.open({ ...(req.headers.origin ? { origin: req.headers.origin } : {}) });
        const roleSent = { value: false };
        const state = newPiAdaptState();
        try {
          for await (const pev of piStream) {
            for (const ce of piEventToChatStreamEvents(pev, state)) {
              for (const chunk of streamEventToOpenAIChunks(ce, { id, created, model: chatReq.model, roleSent })) {
                responseStream.write(`data: ${chunk}\n\n`);
              }
            }
          }
        } catch (err) {
          responseStream.write(`data: ${JSON.stringify({ error: { message: err instanceof Error ? err.message : String(err) } })}\n\n`);
        } finally {
          responseStream.end("data: [DONE]\n\n");
        }
        return;
      }
    }

    // 云端非流式 → pi-ai completeSimple（与流式同源统一鉴权/OAuth）。非云端 → null → 回退引擎。
    if (body.stream !== true) {
      const cloud = await tryCompleteCloud(deps, chatReq);
      if (cloud.type === "ok") return chatResponseToOpenAI(piAssistantToChatResponse(cloud.message, chatReq.model), genId(), Math.floor(Date.now() / 1000));
      if (cloud.type === "error") return reply.code(502).send({ error: { message: errorMessage(cloud.error) } });
    }

    let engine;
    try {
      engine = registry.resolve(chatReq.model);
    } catch {
      return reply.code(404).send({ error: { message: `model not found: ${chatReq.model}` } });
    }

    const id = genId();
    const created = Math.floor(Date.now() / 1000);
    const streamRequested = body.stream === true;

    if (!streamRequested) {
      const res = await engine.chat(chatReq);
      return chatResponseToOpenAI(res, id, created);
    }

    responseStream ??= createGuardedStream(reply);
    responseStream.open({ ...(req.headers.origin ? { origin: req.headers.origin } : {}) });
    const roleSent = { value: false };
    try {
      for await (const ev of engine.chatStream({ ...chatReq, signal: responseStream.signal })) {
        for (const chunk of streamEventToOpenAIChunks(ev, { id, created, model: chatReq.model, roleSent })) {
          responseStream.write(`data: ${chunk}\n\n`);
        }
      }
    } catch (err) {
      responseStream.write(
        `data: ${JSON.stringify({ error: { message: err instanceof Error ? err.message : String(err) } })}\n\n`,
      );
    } finally {
      responseStream.end("data: [DONE]\n\n");
    }
  });

  // ---- Anthropic Messages API 兼容（让走 Anthropic 协议的客户端，如 Claude Code，可接入）----
  app.post("/v1/messages", async (req, reply) => {
    const body = req.body as AnthropicRequestBody;
    // 本地已加载模型 → 透传到 router 原生 /v1/messages（含 tool_use，需 --jinja，已带）。
    const localBase = body.model ? deps.localBaseUrl?.(body.model) : undefined;
    if (localBase) return proxyToLocal(localBase, "/messages", req, reply, deps.fetch ?? fetch, deps.localApiKey?.());

    const chatReq = anthropicToChatRequest(body);
    if (!chatReq.model) return reply.code(400).send({ type: "error", error: { message: "missing model" } });
    let responseStream: GuardedStream | undefined;

    // 云端流式 → pi-ai；非云端/出错 → 回退引擎。
    if (body.stream === true && deps.cloudStream) {
      responseStream = createGuardedStream(reply);
      let piStream: AssistantMessageEventStream | null = null;
      try {
        piStream = await deps.cloudStream(chatReq.model, chatRequestToPiContext(chatReq), {
          signal: responseStream.signal,
          ...(chatReq.temperature != null ? { temperature: chatReq.temperature } : {}),
          ...(chatReq.maxTokens != null ? { maxTokens: chatReq.maxTokens } : {}),
        });
      } catch {
        piStream = null;
      }
      if (piStream) {
        const id = `msg_${Date.now().toString(36)}${(counter += 1).toString(36)}`;
        responseStream.open({ ...(req.headers.origin ? { origin: req.headers.origin } : {}) });
        const tr = new AnthropicStreamTranslator(id, chatReq.model);
        const state = newPiAdaptState();
        try {
          responseStream.write(tr.start());
          for await (const pev of piStream) {
            for (const ce of piEventToChatStreamEvents(pev, state)) responseStream.write(tr.event(ce));
          }
          responseStream.write(tr.end());
        } catch (err) {
          responseStream.write(`event: error\ndata: ${JSON.stringify({ type: "error", error: { message: err instanceof Error ? err.message : String(err) } })}\n\n`);
        } finally {
          responseStream.end();
        }
        return;
      }
    }

    // 云端非流式 → pi-ai completeSimple。非云端 → null → 回退引擎。
    if (body.stream !== true) {
      const cloud = await tryCompleteCloud(deps, chatReq);
      if (cloud.type === "ok") {
        const id = `msg_${Date.now().toString(36)}${(counter += 1).toString(36)}`;
        return chatResponseToAnthropic(piAssistantToChatResponse(cloud.message, chatReq.model), id, chatReq.model);
      }
      if (cloud.type === "error") return reply.code(502).send({ type: "error", error: { type: "api_error", message: errorMessage(cloud.error) } });
    }

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

    responseStream ??= createGuardedStream(reply);
    responseStream.open({ ...(req.headers.origin ? { origin: req.headers.origin } : {}) });
    const tr = new AnthropicStreamTranslator(id, chatReq.model);
    responseStream.write(tr.start());
    try {
      for await (const ev of engine.chatStream({ ...chatReq, signal: responseStream.signal })) {
        const frame = tr.event(ev);
        if (frame) responseStream.write(frame);
      }
      responseStream.write(tr.end());
    } catch (err) {
      responseStream.write(
        `event: error\ndata: ${JSON.stringify({ type: "error", error: { message: err instanceof Error ? err.message : String(err) } })}\n\n`,
      );
    } finally {
      responseStream.end();
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
