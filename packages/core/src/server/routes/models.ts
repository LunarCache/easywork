import os from "node:os";
import { z } from "zod";
import {
  GGUFVariantSchema,
  LocalLoadOptionsSchema,
  LocalModelRuntimeSettingsSchema,
  type DownloadEvent,
} from "@ew/shared";
import { resolveLlamaBin, LLAMA_INSTALL } from "../../engine/resolve-llama.js";
import { providerModelRouteId, runtimeModelForProviderConfig } from "../../providers/catalog.js";
import type { CoreHttpContext } from "../context.js";

export interface ModelRouteOptions {
  llamaBinPath?: string;
  persistLocalNet(bindHost: "127.0.0.1" | "0.0.0.0"): void;
  clearEmbedSetting(): void;
}

const LocalNetSchema = z.object({
  bindHost: z.enum(["127.0.0.1", "0.0.0.0"]),
  apiKey: z.string().optional(),
});

const LocalModelSettingsBodySchema = z.object({
  id: z.string().min(1),
  settings: LocalModelRuntimeSettingsSchema.default({}),
});

function lanIPv4(): string | undefined {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === "IPv4" && !ni.internal) return ni.address;
    }
  }
  return undefined;
}

export function registerModelRoutes(ctx: CoreHttpContext, opts: ModelRouteOptions): void {
  const { app, registry, local, models, localModelSettings, providers, sessionHost, embeddings } = ctx;
  const availableModelIds = (): string[] => [...new Set([...registry.routedModels(), ...providers.modelIds()])];
  const modelSources = () => {
    const byProvider = new Map<string, {
      id: string;
      kind: "provider";
      label: string;
      providerId: string;
      providerKind: "openai-compatible" | "pi-native";
      modelId: string;
      reasoning: boolean;
    }>();
    for (const provider of providers.list()) {
      for (const id of provider.models) {
        const routeId = providerModelRouteId(provider.id, id);
        const config = providers.resolveModelRef(routeId)?.config;
        byProvider.set(routeId, {
          id: routeId,
          kind: "provider",
          label: provider.id,
          providerId: provider.id,
          providerKind: provider.kind,
          modelId: id,
          reasoning: config ? runtimeModelForProviderConfig(config, id).reasoning : false,
        });
      }
    }
    const localIds = new Set([...local.loadedIds(), ...Object.keys(local.contexts()), ...local.endpoints().map((ep) => ep.id)]);
    return availableModelIds().map((id) => {
      const provider = byProvider.get(id);
      if (provider) return provider;
      if (localIds.has(id)) return { id, kind: "local" as const, label: "本地模型" };
      return { id, kind: "engine" as const, label: "其它模型" };
    });
  };

  // ---- 引擎 / 已加载模型 ----
  app.get("/models", async () => ({
    routed: availableModelIds(),
    modelSources: modelSources(),
    // 本地模型窗口（router n_ctx）+ 云端 provider 手动配置的窗口 → UI 进度环分母。
    context: { ...providers.contexts(), ...local.contexts() },
    engines: registry.list().map((e) => ({ id: e.id, capabilities: e.capabilities })),
    // 本地 router 对外端点（发现/外部直连）+ 当前绑定 host。
    endpoints: local.endpoints(),
    bindHost: local.getBindHost(),
  }));

  // ---- 本地网络暴露：router 绑定 host（127.0.0.1 仅本机 / 0.0.0.0 局域网，后者强制 api-key） ----
  app.get("/settings/local-net", async () => ({
    bindHost: local.getBindHost(),
    apiKey: local.getApiKey() ?? null,
    lanIp: lanIPv4(),
    endpoints: local.endpoints(),
  }));
  app.post("/settings/local-net", async (req, reply) => {
    const parsed = LocalNetSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", detail: parsed.error.format() });
    }
    const { bindHost } = parsed.data;
    // 提供了 apiKey 用新值，否则沿用当前。绑 0.0.0.0 必须有非空 key。
    const effectiveKey = parsed.data.apiKey !== undefined ? parsed.data.apiKey.trim() : local.getApiKey();
    if (bindHost === "0.0.0.0" && !effectiveKey) {
      return reply.code(400).send({ error: "api_key_required", message: "绑定 0.0.0.0 暴露到局域网时必须设置 api-key" });
    }
    await local.applyNet({ bindHost, apiKey: effectiveKey || undefined }); // 重载已加载模型立即生效
    opts.persistLocalNet(bindHost);
    sessionHost.invalidateAll(); // 端口/key 变更 → 重建会话，避免指向旧端口/旧鉴权
    return {
      ok: true,
      bindHost: local.getBindHost(),
      apiKey: local.getApiKey() ?? null,
      lanIp: lanIPv4(),
      endpoints: local.endpoints(),
    };
  });

  app.post("/models/load", async (req, reply) => {
    const parsed = LocalLoadOptionsSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_options", detail: parsed.error.format() });
    }
    const res = await local.load(parsed.data);
    return { id: res.id, contextSize: res.contextSize };
  });

  app.post("/models/unload", async (req, reply) => {
    const body = req.body as { id?: string };
    if (!body?.id) return reply.code(400).send({ error: "missing_id" });
    await local.unload(body.id);
    return { ok: true };
  });

  // ---- 本地推理运行时（llama.app 的统一 `llama`）----
  app.get("/local/runtime", async () => {
    const bin = resolveLlamaBin(opts.llamaBinPath ?? process.env.EW_LLAMA_BIN);
    return {
      found: !!bin,
      ...(bin ? { path: bin } : {}),
      install: process.platform === "win32" ? LLAMA_INSTALL.windows : LLAMA_INSTALL.unix,
    };
  });
  app.post("/local/install-runtime", async (_req, reply) => {
    const cmd = process.platform === "win32" ? LLAMA_INSTALL.windows : LLAMA_INSTALL.unix;
    const shell = process.platform === "win32" ? ["powershell", "-NoProfile", "-Command", cmd] : ["sh", "-lc", cmd];
    const { spawn } = await import("node:child_process");
    const result = await new Promise<{ code: number | null; output: string }>((resolve) => {
      const child = spawn(shell[0]!, shell.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      const onData = (b: Buffer) => {
        out += b.toString();
        if (out.length > 200_000) out = out.slice(-200_000);
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      const timer = setTimeout(() => child.kill("SIGKILL"), 300_000);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, output: out });
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve({ code: -1, output: `${out}\n[启动失败] ${e.message}` });
      });
    });
    // 安装后重新解析并热更新本地后端的二进制路径（下次 load 即用新装的 llama）。
    const bin = resolveLlamaBin(opts.llamaBinPath ?? process.env.EW_LLAMA_BIN);
    if (bin) local.setBinaryPath(bin);
    if (!bin) return reply.code(500).send({ ok: false, output: result.output, error: "未在 PATH / ~/.local/bin 解析到 llama 运行时" });
    return { ok: result.code === 0 || !!bin, path: bin, output: result.output };
  });

  // ---- 模型管理（HF 搜索 / 变体 / 下载 / 本地扫描） ----
  app.get("/models/search", async (req, reply) => {
    const q = (req.query as { q?: string }).q;
    if (!q) return reply.code(400).send({ error: "missing_query" });
    return { results: await models.search(q) };
  });

  app.get("/models/variants", async (req, reply) => {
    const repoId = (req.query as { repoId?: string }).repoId;
    if (!repoId) return reply.code(400).send({ error: "missing_repoId" });
    return { variants: await models.listVariants(repoId) };
  });

  app.get("/models/local", async () => ({
    models: (await models.scanInventory()).map((model) => ({
      ...model,
      settings: localModelSettings.get(model.routerId ?? model.path),
    })),
  }));

  app.get("/models/local/settings", async (req, reply) => {
    const id = (req.query as { id?: string }).id;
    if (!id) return reply.code(400).send({ error: "missing_id" });
    return { settings: localModelSettings.get(id) };
  });

  app.post("/models/local/settings", async (req, reply) => {
    const parsed = LocalModelSettingsBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", detail: parsed.error.format() });
    }
    return { settings: localModelSettings.set(parsed.data.id, parsed.data.settings) };
  });

  // 删除本地模型（id = gguf 全路径）：先卸载（若在跑），再删文件。
  app.post("/models/local/delete", async (req, reply) => {
    const id = (req.body as { id?: string })?.id;
    if (!id) return reply.code(400).send({ error: "missing_id" });
    try {
      const target = (await models.scanInventory()).find((m) => m.path === id || m.routerId === id || m.id === id);
      await local.unload(id);
      // 若删的是当前向量记忆引擎的模型：停掉独立 `--embedding` 进程 + 清持久化设置，
      // 否则 EmbeddingService 仍在跑（不归 router 管），状态会一直显示「运行中/已启用」。
      if (embeddings.info.modelId === id) {
        await embeddings.stop().catch(() => {});
        opts.clearEmbedSetting();
      }
      const res = await models.deleteLocal(id);
      localModelSettings.deleteMany([id, target?.path, target?.routerId, target?.id]);
      return { ok: true, removed: res.removed };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: (e as Error).message });
    }
  });

  app.post("/models/download", async (req, reply) => {
    const parsed = GGUFVariantSchema.safeParse((req.body as { variant?: unknown })?.variant);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_variant", detail: parsed.error.format() });
    }
    const hfToken = (req.body as { hfToken?: string }).hfToken;

    const ac = new AbortController();
    reply.raw.on("close", () => ac.abort());
    reply.hijack();
    const raw = reply.raw;
    raw.on("error", () => {});
    raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": req.headers.origin ?? "*",
    });
    const send = (ev: DownloadEvent) => {
      if (!raw.writableEnded && !raw.destroyed) raw.write(`data: ${JSON.stringify(ev)}\n\n`);
    };
    try {
      for await (const ev of models.download(parsed.data, {
        signal: ac.signal,
        ...(hfToken ? { hfToken } : {}),
      })) {
        send(ev);
      }
    } catch (err) {
      send({ type: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      if (!raw.writableEnded && !raw.destroyed) raw.write("data: [DONE]\n\n");
      try {
        raw.end();
      } catch {
        /* ignore */
      }
    }
  });
}
