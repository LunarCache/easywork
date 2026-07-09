import { z } from "zod";
import { MemoryLayerSchema, isWorkspaceScope } from "@ew/shared";
import type { DownloadEvent } from "@ew/shared";
import type { CoreHttpContext } from "../context.js";

export interface MemoryRouteOptions {
  defaultEmbedRepo: string;
  defaultEmbedFile: string;
  downloadEmbeddingModel(repoId: string, fileName: string): AsyncIterable<DownloadEvent>;
  saveEmbedSetting(modelPath: string): void;
}

const MemoryWriteSchema = z.object({
  scope: z.string().optional(),
  layer: MemoryLayerSchema,
  text: z.string(),
  sessionId: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

export function registerMemoryRoutes(ctx: CoreHttpContext, opts: MemoryRouteOptions): void {
  const { app, memory, embeddings } = ctx;

  app.get("/memory", async (req, reply) => {
    const q = req.query as { scope?: string; layer?: string; sessionId?: string };
    const layer = q.layer ? MemoryLayerSchema.safeParse(q.layer) : null;
    if (layer && !layer.success) return reply.code(400).send({ error: "invalid_layer" });
    return {
      items: await memory.list({
        ...(q.scope ? { scope: q.scope } : {}),
        ...(layer?.success ? { layer: layer.data } : {}),
        ...(q.sessionId ? { sessionId: q.sessionId } : {}),
      }),
    };
  });
  app.post("/memory", async (req, reply) => {
    const parsed = MemoryWriteSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_memory", detail: parsed.error.format() });
    }
    return memory.write(parsed.data);
  });
  app.patch("/memory/:id", async (req, reply) => {
    const body = (req.body ?? {}) as { text?: string };
    if (typeof body.text !== "string" || !body.text.trim()) {
      return reply.code(400).send({ error: "invalid_text" });
    }
    try {
      return await memory.edit((req.params as { id: string }).id, { text: body.text });
    } catch (e) {
      return reply.code(404).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });
  app.delete("/memory/:id", async (req) => {
    await memory.delete((req.params as { id: string }).id);
    return { ok: true };
  });
  // 清空某作用域整池（仅限工作区私有池）。scope 经 encodeURIComponent 传入（含 ws: 前缀的冒号）。
  // 护栏：拒绝清空全局池——全局记忆只能逐条删/手工编辑 markdown，避免一键误删共享记忆。
  app.delete("/memory/scope/:scope", async (req, reply) => {
    const scope = (req.params as { scope: string }).scope;
    if (!scope) return reply.code(400).send({ error: "scope_required" });
    if (!isWorkspaceScope(scope)) {
      return reply.code(400).send({ error: "scope_not_clearable", message: "只能整池清空工作区作用域（ws:*）" });
    }
    return { removed: await memory.deleteByScope(scope) };
  });

  // 召回（调试/检视；带相关度分数）。
  app.get("/memory/recall", async (req, reply) => {
    const q = req.query as { q?: string; topK?: string; sessionId?: string; scope?: string };
    if (!q.q) return reply.code(400).send({ error: "missing_query" });
    return {
      hits: await memory.recall({
        query: q.q,
        ...(q.scope ? { scope: q.scope } : {}),
        ...(q.sessionId ? { sessionId: q.sessionId } : {}),
        ...(q.topK ? { topK: Number(q.topK) } : {}),
      }),
    };
  });

  app.get("/memory/embedding", async () => embeddings.info);
  app.post("/memory/embedding", async (req) => {
    const body = (req.body ?? {}) as { repoId?: string; fileName?: string; modelPath?: string };
    let modelPath = body.modelPath;
    if (!modelPath) {
      for await (const ev of opts.downloadEmbeddingModel(
        body.repoId ?? opts.defaultEmbedRepo,
        body.fileName ?? opts.defaultEmbedFile,
      )) {
        if (ev.type === "done") modelPath = ev.model.path;
        else if (ev.type === "error") throw new Error(ev.message);
      }
    }
    if (!modelPath) throw new Error("embedding 模型下载失败");
    const { dim } = await embeddings.setModel(modelPath);
    const reindexed = await memory.reindex();
    opts.saveEmbedSetting(modelPath);
    return { ...embeddings.info, dim, reindexed };
  });
}
