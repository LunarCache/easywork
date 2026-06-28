import fs from "node:fs";
import fsPath from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import Fastify, { type FastifyInstance } from "fastify";
import {
  ChatMessageSchema,
  ApprovalModeSchema,
  GGUFVariantSchema,
  LocalLoadOptionsSchema,
  McpServerConfigSchema,
  SamplingParamsSchema,
  ThinkLevelSchema,
  MemoryLayerSchema,
  messageText,
  normalizeContent,
  resolvePreviewKind,
  mimeForName,
  type PreviewMeta,
  GLOBAL_SCOPE,
  workspaceScope,
  isWorkspaceScope,
  type AgentEvent,
  type ContentPart,
  type DownloadEvent,
  type McpServerConfig,
} from "@ew/shared";
import { LlamaServeEngine } from "@ew/providers";
import { builtinTools } from "@ew/tools";
import { SkillManager } from "@ew/skills";
import { McpClientManager } from "@ew/mcp";
import { LocalMemoryProvider } from "@ew/memory";
import { z } from "zod";
import { EngineRegistry } from "../engine/registry.js";
import { ModelManager } from "../models/manager.js";
import { ProviderManager, type CloudProviderConfig } from "../providers/manager.js";
import { registerOpenAICompat } from "../openai-compat/router.js";
import { SessionHost } from "../agent/session-host.js";
import { ToolTurnRecorder } from "../agent/turn-recorder.js";
import { ApprovalRegistry, SseApprovalGate } from "../agent/approval-sse.js";
import { SqliteConversationRepo } from "../store/conversation.js";
import { EmbeddingService } from "../memory/embedding-service.js";
import { buildFactExtractor } from "../memory/fact-extractor.js";
import { GitService } from "../git/git.js";
import { listDir, readFileSafe, readRawSafe, statFileSafe } from "@ew/tools";
import { KnowledgeBaseStore } from "../rag/store.js";
import { parseFile } from "../rag/parse.js";
import { RouterServerManager } from "../engine/router-server-manager.js";
import { getFreePort } from "../engine/net.js";
import type { LocalBackend } from "../engine/local-backend.js";
import { resolveLlamaBin, LLAMA_INSTALL } from "../engine/resolve-llama.js";
import {
  dataDir as defaultDataDir,
  dbPath as defaultDbPath,
  memoryDir as defaultMemoryDir,
  modelsDir as defaultModelsDir,
  defaultWorkspaceDir,
  chatWorkspaceDir,
} from "../config/paths.js";

export interface CoreServer {
  app: FastifyInstance;
  registry: EngineRegistry;
  local: LocalBackend;
  models: ModelManager;
  providers: ProviderManager;
  skills: SkillManager;
  mcp: McpClientManager;
  memory: LocalMemoryProvider;
  embeddings: EmbeddingService;
  kb: KnowledgeBaseStore;
  repo: SqliteConversationRepo;
  token: string;
  start(opts?: { port?: number; host?: string }): Promise<{ port: number; host: string }>;
  stop(): Promise<void>;
}

export interface CreateCoreOptions {
  token?: string;
  /** 覆盖模型目录（测试用）。 */
  modelsDir?: string;
  extraModelDirs?: string[];
  /** Skills 发现目录（默认 <dataDir>/skills）。 */
  skillsDirs?: string[];
  /** agent 工具沙箱工作目录（默认 dataDir）。 */
  workspaceDir?: string;
  /** 会话 SQLite 路径（测试可传 ":memory:"）。 */
  dbPath?: string;
  /** 记忆 markdown 目录。 */
  memoryDir?: string;
  /** 记忆索引 SQLite 路径（测试可传 ":memory:"）。 */
  memoryDbPath?: string;
  /** 知识库 SQLite 路径（测试可传 ":memory:"）。 */
  kbDbPath?: string;
  /** 覆盖 fetch（测试用，拦截 HF / 云端调用）。 */
  fetch?: typeof fetch;
  /** 统一 `llama`（llama.app）可执行文件路径（默认走 PATH 中的 "llama"）。 */
  llamaBinPath?: string;
}

const ProviderConfigSchema = z.object({
  id: z.string(),
  baseUrl: z.string().url(),
  apiKey: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  models: z.array(z.string()),
  contextWindow: z.number().int().positive().optional(),
});

/** 创建核心守护进程（Fastify server + 引擎/模型/provider 管理）。 */
export function createCore(opts: CreateCoreOptions = {}): CoreServer {
  const token = opts.token ?? crypto.randomUUID();
  // 解析统一 `llama`（llama.app）二进制：显式 EW_LLAMA_BIN → PATH / ~/.local/bin 里的 llama。
  const llamaBin = resolveLlamaBin(opts.llamaBinPath ?? process.env.EW_LLAMA_BIN);
  const registry = new EngineRegistry();
  const modelsDirPath = opts.modelsDir ?? defaultModelsDir();

  const models = new ModelManager({
    modelsDir: modelsDirPath,
    extraDirs: opts.extraModelDirs,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });

  // 本地推理（router 模式）：1 个 `llama serve --models-dir` 路由进程,按 model 字段路由 + 按需加载 + LRU。
  // 嵌入模型不走此处（见下方 EmbeddingService）。需统一 `llama`；无则提示经 llama.app 安装。
  const local: LocalBackend = new RouterServerManager(registry, {
    ...(llamaBin ? { binaryPath: llamaBin } : {}),
    modelsDir: modelsDirPath,
    modelsMax: Number(process.env.EW_MAX_LOADED_MODELS) || 4,
    contextsProvider: async () => {
      const out: Record<string, number> = {};
      for (const m of await models.scanInventory()) {
        if (m.routerId && m.contextDefault) out[m.routerId] = m.contextDefault;
      }
      return out;
    },
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  const providers = new ProviderManager(registry, opts.fetch ? { fetch: opts.fetch } : {});

  // Agent 运行时：内置工具（时间/计算器/HTTP/web_search）由宿主桥成 pi customTools；
  // Skills 由 pi 自身发现（resourceLoader）；MCP 由宿主桥成 customTools。
  const skillsDirs = opts.skillsDirs ?? [fsPath.join(defaultDataDir(), "skills")];
  const skills = new SkillManager(skillsDirs);
  const mcp = new McpClientManager();
  // 交互式审批跨请求登记表（/agent/run 挂起 ↔ /agent/approve 解析）。
  const approvalRegistry = new ApprovalRegistry();

  // 本地 CPU embedding 服务（参考 Hermes：nomic-embed-text 语义召回）。经 `llama serve --embedding` 运行。
  const embeddings = new EmbeddingService({
    makeEngine: async (modelPath) => {
      const port = await getFreePort();
      return new LlamaServeEngine({
        id: "embed",
        modelPath,
        embedding: true,
        port,
        ...(llamaBin ? { binaryPath: llamaBin } : {}),
      });
    },
  });
  const vecExtensionPath = resolveVecExtensionPath();
  const memory = new LocalMemoryProvider({
    dir: opts.memoryDir ?? defaultMemoryDir(),
    dbPath: opts.memoryDbPath ?? `${defaultDataDir()}/memory.db`,
    embed: (texts) => embeddings.embed(texts),
    // 轮后用当轮对话模型抽取持久事实写入全局层（复用已加载模型）。
    extract: buildFactExtractor({ resolveEngine: (m) => registry.resolve(m) }),
    // sqlite-vec 可加载扩展：记忆语义召回唯一引擎（已移除 JS 余弦）；平台无二进制时召回退化为纯词法。
    ...(vecExtensionPath ? { vecExtensionPath } : {}),
  });
  // markdown 为真相源：监听用户手工编辑并回灌索引（内存库/测试不监听）。
  const stopMemWatch =
    (opts.memoryDbPath ?? "") === ":memory:" ? () => {} : memory.startWatching();

  // 文档知识库 RAG：分块 + 嵌入 + 混合检索（语义走 sqlite-vec，与记忆一致）；非空时暴露 search_knowledge_base 工具。
  const kb = new KnowledgeBaseStore({
    dbPath: opts.kbDbPath ?? `${defaultDataDir()}/kb.db`,
    embed: (texts) => embeddings.embed(texts),
    ...(vecExtensionPath ? { vecExtensionPath } : {}),
  });
  // search_knowledge_base 工具按请求所选集合注入（见 /agent/run），不再全局常驻。

  const repo = new SqliteConversationRepo(opts.dbPath ?? defaultDbPath());

  // 宿主：pi-coding-agent 内核（EW_KERNEL=pi 时托管 /agent/run；默认走 legacy loop）。
  // R3：注入记忆/会话检索/知识库/MCP，使托管会话具备 EasyWork 专有能力。
  const sessionHost = new SessionHost({
    local,
    providers,
    agentDir: fsPath.join(defaultDataDir(), "pi-agent"),
    memory,
    repo,
    kb,
    mcp,
    builtins: builtinTools,
  });

  // ---- 持久化 provider / MCP 配置（重启后恢复）----
  const PROVIDERS_KEY = "providers";
  const MCP_KEY = "mcp.servers";
  const LOCAL_BIND_KEY = "local.bindHost";
  const LOCAL_APIKEY_KEY = "local.apiKey";
  const persistProviders = (): void => {
    try {
      repo.setSetting(PROVIDERS_KEY, JSON.stringify(providers.dump()));
    } catch {
      /* 持久化失败不影响运行 */
    }
  };
  const persistMcp = (): void => {
    try {
      repo.setSetting(MCP_KEY, JSON.stringify(mcp.list()));
    } catch {
      /* 持久化失败不影响运行 */
    }
  };
  // 启动时恢复已保存的配置。
  try {
    const raw = repo.getSetting(PROVIDERS_KEY);
    if (raw) for (const c of JSON.parse(raw) as CloudProviderConfig[]) providers.add(c);
    sessionHost.syncCloudProviders();
  } catch {
    /* 损坏的配置忽略 */
  }
  // 恢复 router 绑定 host + api-key（启动时无已加载模型，applyNet 仅设字段）。
  try {
    const savedBind = repo.getSetting(LOCAL_BIND_KEY) ?? undefined;
    const savedKey = repo.getSetting(LOCAL_APIKEY_KEY) || undefined;
    if (savedBind || savedKey) void local.applyNet({ bindHost: savedBind, apiKey: savedKey });
  } catch {
    /* 忽略 */
  }
  void (async () => {
    try {
      const raw = repo.getSetting(MCP_KEY);
      if (raw) for (const c of JSON.parse(raw) as McpServerConfig[]) await mcp.upsert(c);
    } catch {
      /* 损坏的配置忽略 */
    }
  })();

  const DEFAULT_EMBED_REPO = "nomic-ai/nomic-embed-text-v1.5-GGUF";
  const DEFAULT_EMBED_FILE = "nomic-embed-text-v1.5.Q4_K_M.gguf";
  async function downloadEmbeddingModel(repoId: string, fileName: string): Promise<string> {
    let p = "";
    for await (const ev of models.download({ repoId, fileName, quant: "", sizeBytes: 0, shardCount: 1 })) {
      if (ev.type === "done") p = ev.model.path;
      else if (ev.type === "error") throw new Error(ev.message);
    }
    if (!p) throw new Error("embedding 模型下载失败");
    return p;
  }

  // 持久化已启用的 embedding 模型，并在启动时自动重新加载（模型文件已在磁盘 → 自动开启向量记忆）。
  const embedSettingPath = fsPath.join(opts.workspaceDir ?? defaultDataDir(), "embedding.json");
  const defaultEmbedPath = (): string =>
    fsPath.join(modelsDirPath, DEFAULT_EMBED_REPO.replace(/[^a-zA-Z0-9._-]+/g, "__"), DEFAULT_EMBED_FILE);
  const saveEmbedSetting = (modelPath: string): void => {
    try {
      fs.writeFileSync(embedSettingPath, JSON.stringify({ modelPath }));
    } catch {
      /* ignore */
    }
  };
  const readEmbedSetting = (): string | undefined => {
    try {
      return (JSON.parse(fs.readFileSync(embedSettingPath, "utf8")) as { modelPath?: string }).modelPath;
    } catch {
      return undefined;
    }
  };
  async function autoEnableEmbedding(): Promise<void> {
    const persisted = readEmbedSetting();
    const candidate =
      persisted && fs.existsSync(persisted)
        ? persisted
        : fs.existsSync(defaultEmbedPath())
          ? defaultEmbedPath()
          : undefined;
    if (!candidate) return;
    try {
      const { dim } = await embeddings.setModel(candidate);
      const n = await memory.reindex();
      saveEmbedSetting(candidate);
      console.error(`[easywork] 向量记忆已自动启用: ${candidate} (${dim} 维, reindex ${n})`);
    } catch (e) {
      console.error("[easywork] 向量记忆自动启用失败:", e);
    }
  }

  const app = Fastify({ logger: false, bodyLimit: 32 * 1024 * 1024 });

  // CORS（本地工作台：放行浏览器 UI 跨域）。必须在鉴权之前，且预检 OPTIONS 不走鉴权。
  app.addHook("onRequest", async (req, reply) => {
    reply.header("access-control-allow-origin", req.headers.origin ?? "*");
    reply.header("vary", "origin");
    reply.header("access-control-allow-methods", "GET,POST,PATCH,DELETE,OPTIONS");
    reply.header("access-control-allow-headers", "authorization,content-type");
    reply.header("access-control-max-age", "86400");
    if (req.method === "OPTIONS") {
      return reply.code(204).send();
    }
  });

  // bearer 鉴权（/health 与预检 OPTIONS 免鉴权）。
  app.addHook("onRequest", async (req, reply) => {
    if (req.method === "OPTIONS") return;
    if (req.url === "/health" || req.url.startsWith("/health?")) return;
    if (req.headers.authorization !== `Bearer ${token}`) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.get("/health", async () => ({ ok: true, name: "easywork-core" }));

  // ---- 引擎 / 已加载模型 ----
  app.get("/models", async () => ({
    routed: registry.routedModels(),
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
  const LocalNetSchema = z.object({
    bindHost: z.enum(["127.0.0.1", "0.0.0.0"]),
    apiKey: z.string().optional(),
  });
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
    try {
      repo.setSetting(LOCAL_BIND_KEY, bindHost);
      repo.setSetting(LOCAL_APIKEY_KEY, local.getApiKey() ?? "");
    } catch {
      /* 持久化失败不影响运行 */
    }
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
  // 探测 llama 运行时是否就绪（缺失时 UI 引导经 llama.app 安装）。
  app.get("/local/runtime", async () => {
    const bin = resolveLlamaBin(opts.llamaBinPath ?? process.env.EW_LLAMA_BIN);
    return {
      found: !!bin,
      ...(bin ? { path: bin } : {}),
      install: process.platform === "win32" ? LLAMA_INSTALL.windows : LLAMA_INSTALL.unix,
    };
  });
  // 经 llama.app 官方脚本安装统一 llama 二进制（→ ~/.local/bin/llama）。用户在 UI 主动触发。
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

  app.get("/models/local", async () => ({ models: await models.scanInventory() }));

  // 删除本地模型（id = gguf 全路径）：先卸载（若在跑），再删文件。
  app.post("/models/local/delete", async (req, reply) => {
    const id = (req.body as { id?: string })?.id;
    if (!id) return reply.code(400).send({ error: "missing_id" });
    try {
      await local.unload(id);
      // 若删的是当前向量记忆引擎的模型：停掉独立 `--embedding` 进程 + 清持久化设置，
      // 否则 EmbeddingService 仍在跑（不归 router 管），状态会一直显示「运行中/已启用」。
      if (embeddings.info.modelId === id) {
        await embeddings.stop().catch(() => {});
        try {
          fs.rmSync(embedSettingPath, { force: true });
        } catch {
          /* ignore */
        }
      }
      const res = await models.deleteLocal(id);
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
    raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": req.headers.origin ?? "*",
    });
    const send = (ev: DownloadEvent) => raw.write(`data: ${JSON.stringify(ev)}\n\n`);
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
      raw.write("data: [DONE]\n\n");
      raw.end();
    }
  });

  // ---- 云端 provider 配置 ----
  app.get("/providers", async () => ({ providers: providers.list() }));

  app.post("/providers", async (req, reply) => {
    const parsed = ProviderConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_provider", detail: parsed.error.format() });
    }
    providers.add(parsed.data);
    persistProviders();
    sessionHost.syncCloudProviders();
    return { ok: true };
  });

  app.delete("/providers/:id", async (req) => {
    providers.remove((req.params as { id: string }).id);
    persistProviders();
    sessionHost.syncCloudProviders();
    return { ok: true };
  });

  // ---- 流式对话（内部 SSE，渠道无关事件） ----
  // 注：纯流式对话 /chat/stream 已移除——应用内一律走 /agent/run（pi 托管），
  // 裸模型对话直接打 OpenAI 兼容的 /v1/chat/completions。

  // ---- Agent 运行（pi 托管会话，SSE 发 AgentEvent） ----
  const AgentRunSchema = z.object({
    threadId: z.string().default("default"),
    model: z.string(),
    history: z.array(ChatMessageSchema),
    excludeTools: z.array(z.string()).optional(),
    /** 禁用的 Skill 名称（按名过滤 pi resourceLoader 的 skills）。 */
    excludeSkills: z.array(z.string()).optional(),
    thinkingLevel: ThinkLevelSchema.optional(),
    regenerate: z.boolean().optional(),
    sampling: SamplingParamsSchema.optional(),
    /** 是否启用知识库 RAG（自动注入 + 暴露 search_knowledge_base）。默认关，由聊天「知识库」开关控制。 */
    kb: z.boolean().optional(),
    /** 选用的知识库集合 id；省略=跨全部集合。 */
    kbId: z.string().optional(),
    /** 工作区项目 id；解析其 workspaceDir + 审批策略，注入 fs/exec 工具。 */
    projectId: z.string().optional(),
  });

  app.post("/agent/run", async (req, reply) => {
    const parsed = AgentRunSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", detail: parsed.error.format() });
    }
    try {
      registry.resolve(parsed.data.model);
    } catch (err) {
      return reply.code(404).send({ error: "model_not_loaded", message: String(err) });
    }

    // pi 内核托管：会话内自持历史/技能/compaction，并自行加载项目上下文（AGENTS.md）。
    // 记忆召回/抽取、知识库、MCP、内置工具均由宿主以扩展/customTools 注入（见 SessionHost）。
    const threadId = parsed.data.threadId;
    const projectId = parsed.data.projectId ?? repo.getThread(threadId)?.projectId ?? undefined;
    const project = projectId ? repo.getProject(projectId) : null;
    const isWorkspace = !!project?.workspaceDir;
    // 对话模式 cwd = 每会话工件目录（~/.easywork/workspace/chats/<threadId>），与其他会话隔离；
    // fs 工具读写均限定在此目录内，右侧「工件」面板按此目录展示本会话产出。
    const runWorkspaceDir = project?.workspaceDir ?? chatWorkspaceDir(threadId);
    // 工作区目录「真正聊天时」才落盘创建（新建工作区时不预建空目录）。
    try {
      fs.mkdirSync(runWorkspaceDir, { recursive: true });
    } catch {
      /* 目录创建失败由后续 fs 工具报错 */
    }

    // 持久化（应用内会话历史）：确保 thread 存在。本轮消息延迟到成功结束才落库——
    // 用户取消时整轮（用户消息 + 部分助手输出 + 工具往返）一律不计入历史/上下文。
    const lastUser = parsed.data.history[parsed.data.history.length - 1];
    const threadCreated = !repo.getThread(threadId);
    if (threadCreated) {
      const title = lastUser ? messageText(lastUser.content).slice(0, 40) || "新会话" : "新会话";
      repo.createThread({
        id: threadId,
        modelId: parsed.data.model,
        title,
        ...(projectId ? { projectId } : {}),
      });
    }
    let finalContent = "";

    const ac = new AbortController();
    reply.raw.on("close", () => ac.abort());
    reply.hijack();
    const raw = reply.raw;
    raw.on("error", () => {}); // 客户端断开后写 socket 不致命
    raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": req.headers.origin ?? "*",
    });
    const send = (ev: AgentEvent) => {
      if (!raw.writableEnded && !raw.destroyed) raw.write(`data: ${JSON.stringify(ev)}\n\n`);
    };
    // 交互式审批门：危险工具经 SSE approval-request 事件挂起，等 /agent/approve 解析。
    const runApproval = new SseApprovalGate({
      registry: approvalRegistry,
      emit: (ev) => send(ev),
      signal: ac.signal,
    });

    // 从事件流重建工具往返（assistant tool_calls + tool results），缓冲到本轮成功结束再落库。
    const recorder = new ToolTurnRecorder();
    const recorded: ReturnType<ToolTurnRecorder["push"]> = [];

    const userText = lastUser?.role === "user" ? messageText(lastUser.content) : "";
    // 多模态：从本轮用户消息抽出图片片段（base64）→ 透传给 pi（视觉模型 mmproj）。
    // 仅取当前轮；历史轮的图片由 pi 会话上下文自持（按 threadId resume）。
    const userImages =
      lastUser?.role === "user" && Array.isArray(lastUser.content)
        ? lastUser.content.flatMap((p) =>
            p.type === "image" && typeof p.data === "string"
              ? [{ type: "image" as const, data: p.data, mimeType: p.mimeType }]
              : [],
          )
        : [];
    try {
      for await (const ev of sessionHost.run({
        threadId,
        modelId: parsed.data.model,
        text: userText,
        ...(userImages.length ? { images: userImages } : {}),
        cwd: runWorkspaceDir,
        // 工作区模式：按项目审批档位。对话模式：auto-edits —— 写在工作区内放行（escapesCwd 限定），
        // bash 经审批（可产出网页/构建等 artifacts，但每条命令需用户确认）。
        workspace: isWorkspace,
        // 记忆作用域：工作区会话用本工程私有池（隔离）；对话会话用全局池（共享）。
        memoryScope: isWorkspace && projectId ? workspaceScope(projectId) : GLOBAL_SCOPE,
        approval: runApproval,
        approvalMode: isWorkspace ? (project?.approvalMode ?? "approve-each") : "auto-edits",
        signal: ac.signal,
        ...(parsed.data.sampling ? { sampling: parsed.data.sampling } : {}),
        ...(parsed.data.thinkingLevel !== undefined ? { thinkingLevel: parsed.data.thinkingLevel } : {}),
        ...(parsed.data.regenerate ? { regenerate: true } : {}),
        ...(parsed.data.excludeSkills?.length ? { excludeSkills: parsed.data.excludeSkills } : {}),
      })) {
        recorded.push(...recorder.push(ev));
        if (ev.type === "final") finalContent = messageText(ev.message.content);
        send(ev);
      }
      // 仅在「未被取消」时落库：用户取消 → 整轮不计入历史（与 pi 上下文回滚一致）。
      if (!ac.signal.aborted) {
        if (lastUser?.role === "user") {
          repo.appendMessage({
            id: crypto.randomUUID(),
            threadId,
            role: "user",
            seq: repo.nextSeq(threadId),
            parts: normalizeContent(lastUser.content),
            createdAt: new Date().toISOString(),
          });
        }
        for (const m of recorded) {
          repo.appendMessage({
            id: crypto.randomUUID(),
            threadId,
            role: m.role,
            seq: repo.nextSeq(threadId),
            parts: m.parts,
            ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}),
            ...(m.toolResults ? { toolResults: m.toolResults } : {}),
            createdAt: new Date().toISOString(),
          });
        }
        // 收尾 assistant 消息：思考过程（reasoning）+ 答案。
        // 思考优先取 reasoning 事件（recorder 累计的收尾轮残留）；兜底剥离内联 <think>。
        let answer = finalContent;
        let inlineThink = "";
        if (answer.includes("<think>")) {
          answer = answer.replace(/<think>([\s\S]*?)<\/think>/g, (_m, t: string) => {
            inlineThink += t;
            return "";
          });
        }
        answer = answer.trim();
        // 先各自 trim 再取舍：避免"全空白的事件型 reasoning"短路掉真正有内容的内联 think。
        const reasoningText = recorder.trailingReasoning().trim() || inlineThink.trim();
        const finalParts: ContentPart[] = [
          ...(reasoningText ? [{ type: "reasoning" as const, text: reasoningText }] : []),
          ...(answer ? [{ type: "text" as const, text: answer }] : []),
        ];
        if (finalParts.length > 0) {
          repo.appendMessage({
            id: crypto.randomUUID(),
            threadId,
            role: "assistant",
            seq: repo.nextSeq(threadId),
            parts: finalParts,
            createdAt: new Date().toISOString(),
          });
        }
      } else if (threadCreated && repo.history(threadId).length === 0) {
        // 新建会话的首轮即被取消 → 清掉这个空会话，避免侧栏残留空壳。
        repo.deleteThread(threadId);
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

  // 工具审批回应：解析挂起的 approval-request（verdict: approve / approve-always / deny）。
  const ApproveSchema = z.object({
    id: z.string(),
    verdict: z.enum(["approve", "approve-always", "deny"]),
  });
  app.post("/agent/approve", async (req, reply) => {
    const parsed = ApproveSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_approval" });
    const ok = approvalRegistry.resolve(parsed.data.id, parsed.data.verdict);
    return { ok };
  });

  // ---- MCP 服务器管理 ----
  app.get("/mcp/servers", async () => ({ servers: mcp.list() }));
  app.post("/mcp/servers", async (req, reply) => {
    const parsed = McpServerConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_config", detail: parsed.error.format() });
    }
    await mcp.upsert(parsed.data);
    persistMcp();
    sessionHost.invalidateAll(); // MCP 工具集变更 → 重建会话以刷新 customTools。
    return { ok: true };
  });
  app.delete("/mcp/servers/:id", async (req) => {
    await mcp.remove((req.params as { id: string }).id);
    persistMcp();
    sessionHost.invalidateAll();
    return { ok: true };
  });
  app.post("/mcp/probe", async (req, reply) => {
    const parsed = McpServerConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_config", detail: parsed.error.format() });
    }
    return mcp.probe(parsed.data);
  });
  app.get("/mcp/servers/:id/tools", async (req) => {
    const tools = await mcp.listToolsOf((req.params as { id: string }).id);
    return { tools };
  });

  // ---- 知识库 RAG ----
  const KbIngestSchema = z.object({
    source: z.string().min(1),
    text: z.string().min(1),
    kbId: z.string().optional(),
  });
  app.get("/kb/list", async () => ({ kbs: kb.listKbs() }));
  app.get("/kb/docs", async (req) => {
    const kbId = (req.query as { kbId?: string }).kbId;
    return { docs: kb.listDocs(kbId), chunks: kb.count(kbId) };
  });
  // 单文档正文（按 chunk 拼接）+ 元数据，供 UI 预览。
  app.get("/kb/docs/:id", async (req, reply) => {
    const doc = kb.docContent((req.params as { id: string }).id);
    if (!doc) return reply.code(404).send({ error: "not_found" });
    return { doc };
  });
  app.post("/kb/docs", async (req, reply) => {
    const parsed = KbIngestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_doc", detail: parsed.error.format() });
    }
    const doc = await kb.ingest(parsed.data);
    return { doc };
  });

  // ---- 本地文件上传 + 异步解析/嵌入 ----
  interface KbJob {
    id: string;
    source: string;
    kbId: string;
    status: "queued" | "parsing" | "embedding" | "done" | "error";
    chunks?: number;
    done?: number;
    total?: number;
    error?: string;
    createdAt: string;
  }
  const kbJobs: KbJob[] = []; // 最近在前，上限 100
  const KbUploadSchema = z.object({
    source: z.string().min(1),
    contentBase64: z.string().min(1),
    kbId: z.string().optional(),
  });
  app.post("/kb/upload", async (req, reply) => {
    const parsed = KbUploadSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_upload", detail: parsed.error.format() });
    }
    const { source, contentBase64 } = parsed.data;
    const kbId = parsed.data.kbId ?? "default";
    const job: KbJob = { id: crypto.randomUUID(), source, kbId, status: "queued", createdAt: new Date().toISOString() };
    kbJobs.unshift(job);
    if (kbJobs.length > 100) kbJobs.length = 100;
    // 后台异步解析 → 分块 → 嵌入 → 入库（不阻塞响应）。
    void (async () => {
      try {
        job.status = "parsing";
        const buf = Buffer.from(contentBase64, "base64");
        const text = parseFile(source, buf);
        if (!text.trim()) throw new Error("解析结果为空");
        job.status = "embedding";
        const doc = await kb.ingest({ source, text, kbId }, (p) => {
          job.done = p.done;
          job.total = p.total;
        });
        job.chunks = doc.chunks;
        job.status = "done";
      } catch (e) {
        job.status = "error";
        job.error = e instanceof Error ? e.message : String(e);
      }
    })();
    return { jobId: job.id };
  });
  app.get("/kb/jobs", async () => ({ jobs: kbJobs.slice(0, 30) }));
  app.delete("/kb/docs/:id", async (req) => {
    kb.deleteDoc((req.params as { id: string }).id);
    return { ok: true };
  });
  app.get("/kb/search", async (req) => {
    const q = req.query as { q?: string; topK?: string; kbId?: string };
    const hits = await kb.retrieve(q.q ?? "", {
      ...(q.kbId ? { kbId: q.kbId } : {}),
      ...(q.topK ? { topK: Number(q.topK) } : {}),
    });
    return { hits };
  });

  // ---- 技能 ----
  const skillsDir = skillsDirs[0] ?? fsPath.join(defaultDataDir(), "skills");
  app.get("/skills", async () => {
    await skills.discover().catch(() => {});
    return { skills: skills.list(), dir: skillsDir };
  });
  // 读取某技能的 SKILL.md 正文（懒加载；用于详情查看）。
  app.get("/skills/:id/body", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const skill = skills.list().find((s) => s.id === id);
    if (!skill) return reply.code(404).send({ error: "not_found" });
    try {
      const body = fs.readFileSync(skill.bodyPath, "utf8");
      return { body, bodyPath: skill.bodyPath };
    } catch (e) {
      return reply.code(500).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });
  // 在系统文件管理器中打开技能目录（本机桌面用）。
  app.post("/skills/open", async (_req, reply) => {
    try {
      fs.mkdirSync(skillsDir, { recursive: true });
      const cmd =
        process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
      const { spawn } = await import("node:child_process");
      spawn(cmd, [skillsDir], { detached: true, stdio: "ignore" }).unref();
      return { ok: true, dir: skillsDir };
    } catch (e) {
      return reply.code(500).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });
  // 新建一个 SKILL.md 模板（在技能目录下建子目录）。
  app.post("/skills/template", async (req, reply) => {
    const body = (req.body ?? {}) as { name?: string };
    const name = (body.name ?? "my-skill").replace(/[^a-zA-Z0-9._-]+/g, "-").toLowerCase() || "my-skill";
    const dir = fsPath.join(skillsDir, name);
    const file = fsPath.join(dir, "SKILL.md");
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (!fs.existsSync(file)) {
        fs.writeFileSync(
          file,
          `---
name: ${name}
description: 一句话说明这个技能做什么（会进系统提示目录）
whenToUse: 描述什么情况下模型应该调用 open_skill 加载本技能
version: "0.1.0"
---

# ${name}

在这里写技能正文：步骤、约定、示例。模型调用 open_skill("${name}") 时才会注入这部分内容。
`,
        );
      }
      await skills.discover().catch(() => {});
      return { ok: true, file };
    } catch (e) {
      return reply.code(500).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // ---- 会话 ----
  app.get("/threads", async (req) => {
    const projectId = (req.query as { projectId?: string }).projectId;
    return { threads: repo.listThreads(projectId ? { projectId } : undefined) };
  });
  app.get("/threads/:id/messages", async (req) => ({
    messages: repo.history((req.params as { id: string }).id),
  }));
  // 该会话最后一轮的上下文用量（打开历史会话时回填进度环；无 pi 日志则 null）。
  app.get("/threads/:id/usage", async (req) => ({
    usage: sessionHost.lastUsage((req.params as { id: string }).id),
  }));
  // 手动压缩该会话上下文（pi session.compact()）；排进该 thread 的 run 串行链。无活动会话则 skipped。
  app.post("/threads/:id/compact", async (req) => sessionHost.compact((req.params as { id: string }).id));
  app.delete("/threads/:id", async (req) => {
    const id = (req.params as { id: string }).id;
    const projectId = repo.getThread(id)?.projectId;
    repo.deleteThread(id); // 删 SQLite 会话 + 消息 + FTS
    sessionHost.dispose(id); // 彻底删除：丢弃进程内 pi 会话上下文 + 落盘 session 文件 + 待抽取缓冲
    const facts = await memory.deleteBySession(id).catch(() => 0); // 一并清除该对话抽取出的记忆事实
    // 对话会话（无项目）：删掉其每会话工件目录（软件 scratch；工作区会话用项目目录，不动）。
    if (!projectId) {
      try {
        fs.rmSync(chatWorkspaceDir(id), { recursive: true, force: true });
      } catch {
        /* 删工件目录失败不致命 */
      }
    }
    return { ok: true, factsRemoved: facts };
  });

  // ---- 工作区项目（Project = 本地目录 + 审批策略） ----
  const ProjectCreateSchema = z.object({
    name: z.string().min(1).optional(),
    workspaceDir: z.string().optional(),
    approvalMode: ApprovalModeSchema.optional(),
    instructions: z.string().optional(),
  });
  const ProjectPatchSchema = ProjectCreateSchema.partial();

  app.get("/projects", async () => ({ projects: repo.listProjects() }));
  app.post("/projects", async (req, reply) => {
    const parsed = ProjectCreateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_project", detail: parsed.error.format() });
    if (parsed.data.workspaceDir && !isExistingDir(parsed.data.workspaceDir)) {
      return reply.code(400).send({ error: "invalid_dir", message: "workspaceDir 不是有效目录" });
    }
    // 未指定目录 → 解析默认工作区下的 NewProject{N} 路径（不预建目录，真正聊天时才落盘）。
    const workspaceDir = parsed.data.workspaceDir?.trim() || nextNewProjectDir(repo);
    const name = parsed.data.name?.trim() || fsPath.basename(workspaceDir);
    return repo.createProject({ ...parsed.data, name, workspaceDir });
  });
  app.patch("/projects/:id", async (req, reply) => {
    const parsed = ProjectPatchSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_project" });
    if (parsed.data.workspaceDir && !isExistingDir(parsed.data.workspaceDir)) {
      return reply.code(400).send({ error: "invalid_dir", message: "workspaceDir 不是有效目录" });
    }
    try {
      return repo.updateProject((req.params as { id: string }).id, parsed.data);
    } catch {
      return reply.code(404).send({ error: "not_found" });
    }
  });
  app.delete("/projects/:id", async (req) => {
    const id = (req.params as { id: string }).id;
    // 删除工作区时，连同其下会话一并彻底删除（消息 + pi 会话上下文/落盘文件），不留孤儿会话。
    for (const t of repo.listThreads({ projectId: id })) {
      repo.deleteThread(t.id);
      sessionHost.dispose(t.id);
    }
    // 工作区的私有记忆池整体清除（隔离作用域 ws:<id>）。
    await memory.deleteByScope(workspaceScope(id)).catch(() => 0);
    repo.deleteProject(id);
    return { ok: true };
  });

  // 工作区只读文件浏览（供 UI 文件树 / 文件查看）。写经 agent fs 工具走审批，不开直接写端点。
  const projectRoot = (id: string): string => {
    const p = repo.getProject(id);
    if (!p?.workspaceDir) throw new Error("project_no_workspace");
    return p.workspaceDir;
  };
  app.get("/workspace/:id/fs/list", async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { path?: string; depth?: string };
    try {
      const root = projectRoot(id);
      // 工作区目录尚未落盘创建（首次聊天前）→ 视为空，不报错。
      if (!isExistingDir(root)) return { entries: [] };
      return { entries: listDir(root, q.path ?? ".", q.depth ? Number(q.depth) : 1) };
    } catch (e) {
      return reply.code(400).send({ error: "fs_error", message: e instanceof Error ? e.message : String(e) });
    }
  });
  // 注：单文件读取统一走下面的 /files/meta + /files/raw（FileViewer）；旧 /workspace/:id/fs/read 与 /chat/:threadId/file 已移除。

  // 对话模式工件浏览（只读）：每会话目录 <workspace>/chats/<threadId>，供右侧「工件」面板按会话展示产出。
  app.get("/chat/:threadId/files", async (req, reply) => {
    const { threadId } = req.params as { threadId: string };
    const q = req.query as { path?: string; depth?: string };
    try {
      const root = chatWorkspaceDir(threadId);
      if (!isExistingDir(root)) return { entries: [] }; // 尚未产出任何文件 → 空
      return { entries: listDir(root, q.path ?? ".", q.depth ? Number(q.depth) : 4) };
    } catch (e) {
      return reply.code(400).send({ error: "fs_error", message: e instanceof Error ? e.message : String(e) });
    }
  });

  // —— 统一文件预览（dock 文件 / 工件 共用）：scope=workspace|chat ——
  // /files/meta：渲染类型 + 文本类内联；/files/raw：原始字节（img/pdf 经 blob 渲染）。路径经 readFileSafe/readRawSafe 限定。
  const previewBase = (scope: string, id: string): string =>
    scope === "workspace" ? projectRoot(id) : chatWorkspaceDir(id);
  app.get("/files/meta", async (req, reply) => {
    const q = req.query as { scope?: string; id?: string; path?: string };
    if (!q.scope || !q.id || !q.path) return reply.code(400).send({ error: "params_required" });
    try {
      const base = previewBase(q.scope, q.id);
      const name = q.path.split(/[/\\]/).pop() || q.path;
      const kind = resolvePreviewKind(name);
      const mime = mimeForName(name);
      if (kind === "image" || kind === "pdf") {
        const { size } = statFileSafe(base, q.path);
        return { name, mime, kind, size } satisfies PreviewMeta;
      }
      const r = readFileSafe(base, q.path);
      if (r.binary) return { name, mime, kind: "binary", size: r.size } satisfies PreviewMeta;
      return { name, mime, kind, size: r.size, text: r.content ?? "", truncated: !!r.truncated } satisfies PreviewMeta;
    } catch (e) {
      return reply.code(400).send({ error: "fs_error", message: e instanceof Error ? e.message : String(e) });
    }
  });
  app.get("/files/raw", async (req, reply) => {
    const q = req.query as { scope?: string; id?: string; path?: string };
    if (!q.scope || !q.id || !q.path) return reply.code(400).send({ error: "params_required" });
    try {
      const raw = readRawSafe(previewBase(q.scope, q.id), q.path);
      const name = q.path.split(/[/\\]/).pop() || q.path;
      reply.header("content-type", mimeForName(name));
      reply.header("content-length", String(raw.buffer.length));
      reply.header("cache-control", "no-store");
      return reply.send(raw.buffer);
    } catch (e) {
      return reply.code(400).send({ error: "fs_error", message: e instanceof Error ? e.message : String(e) });
    }
  });

  // 工作区/对话目录里执行用户在终端 tab 输入的命令。cwd 限定在该目录；
  // 与 agent run_command 同为任意 shell，靠 daemon token 把守（0.0.0.0 须 api-key）。
  const ExecSchema = z.object({ command: z.string().min(1) });
  const EXEC_TIMEOUT = 120_000;
  const EXEC_CAP = 200_000; // 输出字符上限，超出截断并终止
  const runInDir = async (
    cwd: string,
    command: string,
  ): Promise<{ code: number | null; output: string; truncated: boolean }> => {
    fs.mkdirSync(cwd, { recursive: true });
    const { spawn } = await import("node:child_process");
    return await new Promise((resolve) => {
      const child = spawn(command, { cwd, shell: true });
      let out = "";
      let truncated = false;
      const onData = (b: Buffer) => {
        if (truncated) return;
        out += b.toString();
        if (out.length > EXEC_CAP) {
          out = out.slice(0, EXEC_CAP);
          truncated = true;
          child.kill();
        }
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      const timer = setTimeout(() => {
        truncated = true;
        out += "\n[已超时，进程被终止]";
        child.kill("SIGKILL");
      }, EXEC_TIMEOUT);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, output: out, truncated });
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve({ code: -1, output: `${out}\n[启动失败] ${e.message}`, truncated });
      });
    });
  };
  // 在系统文件管理器中打开某目录（本机桌面用）。
  const revealDir = (dir: string): void => {
    fs.mkdirSync(dir, { recursive: true });
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
    void import("node:child_process").then(({ spawn }) => spawn(cmd, [dir], { detached: true, stdio: "ignore" }).unref());
  };
  app.post("/workspace/:id/exec", async (req, reply) => {
    const p = ExecSchema.safeParse(req.body ?? {});
    if (!p.success) return reply.code(400).send({ error: "command_required" });
    try {
      return await runInDir(projectRoot((req.params as { id: string }).id), p.data.command);
    } catch (e) {
      return reply.code(400).send({ error: "exec_error", message: e instanceof Error ? e.message : String(e) });
    }
  });
  app.post("/chat/:threadId/exec", async (req, reply) => {
    const p = ExecSchema.safeParse(req.body ?? {});
    if (!p.success) return reply.code(400).send({ error: "command_required" });
    return await runInDir(chatWorkspaceDir((req.params as { threadId: string }).threadId), p.data.command);
  });
  app.post("/workspace/:id/reveal", async (req, reply) => {
    try {
      const dir = projectRoot((req.params as { id: string }).id);
      revealDir(dir);
      return { ok: true, dir };
    } catch (e) {
      return reply.code(400).send({ error: "reveal_error", message: e instanceof Error ? e.message : String(e) });
    }
  });
  app.post("/chat/:threadId/reveal", async (req, reply) => {
    const dir = chatWorkspaceDir((req.params as { threadId: string }).threadId);
    revealDir(dir);
    return { ok: true, dir };
  });

  // 工作区 git（status/diff/暂存/提交/还原/分支）。
  const git = (id: string): GitService => new GitService(projectRoot(id));
  app.get("/workspace/:id/git/status", async (req, reply) => {
    try {
      return await git((req.params as { id: string }).id).status();
    } catch {
      return reply.code(400).send({ error: "git_error" });
    }
  });
  app.get("/workspace/:id/git/diff", async (req, reply) => {
    const q = req.query as { path?: string; staged?: string };
    if (!q.path) return reply.code(400).send({ error: "path_required" });
    try {
      return { diff: await git((req.params as { id: string }).id).diff(q.path, { staged: q.staged === "1" }) };
    } catch {
      return reply.code(400).send({ error: "git_error" });
    }
  });
  app.get("/workspace/:id/git/branches", async (req, reply) => {
    try {
      return await git((req.params as { id: string }).id).branches();
    } catch {
      return reply.code(400).send({ error: "git_error" });
    }
  });
  const GitPathsSchema = z.object({ paths: z.array(z.string()).optional(), all: z.boolean().optional() });
  app.post("/workspace/:id/git/stage", async (req, reply) => {
    try {
      const b = GitPathsSchema.parse(req.body ?? {});
      const g = git((req.params as { id: string }).id);
      const r = b.all || !b.paths?.length ? await g.stageAll() : await g.stage(b.paths);
      return { ok: r.ok, error: r.ok ? undefined : r.stderr };
    } catch {
      return reply.code(400).send({ error: "git_error" });
    }
  });
  app.post("/workspace/:id/git/unstage", async (req, reply) => {
    try {
      const b = GitPathsSchema.parse(req.body ?? {});
      const g = git((req.params as { id: string }).id);
      const r = b.all || !b.paths?.length ? await g.unstageAll() : await g.unstage(b.paths);
      return { ok: r.ok, error: r.ok ? undefined : r.stderr };
    } catch {
      return reply.code(400).send({ error: "git_error" });
    }
  });
  app.post("/workspace/:id/git/revert", async (req, reply) => {
    try {
      const b = GitPathsSchema.parse(req.body ?? {});
      const g = git((req.params as { id: string }).id);
      await (b.all || !b.paths?.length ? g.revertAll() : g.revert(b.paths));
      return { ok: true };
    } catch {
      return reply.code(400).send({ error: "git_error" });
    }
  });
  app.post("/workspace/:id/git/commit", async (req, reply) => {
    const b = z.object({ message: z.string().min(1) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "message_required" });
    try {
      const r = await git((req.params as { id: string }).id).commit(b.data.message);
      return { ok: r.ok, error: r.ok ? undefined : r.stderr || r.stdout };
    } catch {
      return reply.code(400).send({ error: "git_error" });
    }
  });
  app.post("/workspace/:id/git/switch", async (req, reply) => {
    const b = z.object({ name: z.string().min(1) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "name_required" });
    try {
      const r = await git((req.params as { id: string }).id).switchBranch(b.data.name);
      return { ok: r.ok, error: r.ok ? undefined : r.stderr };
    } catch {
      return reply.code(400).send({ error: "git_error" });
    }
  });
  app.get("/workspace/:id/git/log", async (req, reply) => {
    const q = req.query as { limit?: string };
    try {
      return { commits: await git((req.params as { id: string }).id).log(q.limit ? Number(q.limit) : 30) };
    } catch {
      return reply.code(400).send({ error: "git_error" });
    }
  });
  app.get("/workspace/:id/git/remote", async (req, reply) => {
    try {
      return await git((req.params as { id: string }).id).remoteInfo();
    } catch {
      return reply.code(400).send({ error: "git_error" });
    }
  });
  app.post("/workspace/:id/git/push", async (req, reply) => {
    try {
      const r = await git((req.params as { id: string }).id).push();
      return { ok: r.ok, message: (r.stderr || r.stdout).trim() };
    } catch {
      return reply.code(400).send({ error: "git_error" });
    }
  });
  app.post("/workspace/:id/git/pull", async (req, reply) => {
    try {
      const r = await git((req.params as { id: string }).id).pull();
      return { ok: r.ok, message: (r.stderr || r.stdout).trim() };
    } catch {
      return reply.code(400).send({ error: "git_error" });
    }
  });
  const HunkSchema = z.object({
    path: z.string().min(1),
    hunkIndex: z.number().int().min(0),
    op: z.enum(["stage", "unstage", "discard"]),
  });
  app.post("/workspace/:id/git/hunk", async (req, reply) => {
    const b = HunkSchema.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "bad_request" });
    try {
      const r = await git((req.params as { id: string }).id).hunkOp(b.data.path, b.data.hunkIndex, b.data.op);
      return { ok: r.ok, error: r.ok ? undefined : r.stderr || r.stdout };
    } catch {
      return reply.code(400).send({ error: "git_error" });
    }
  });

  // ---- 记忆 ----
  const MemoryWriteSchema = z.object({
    scope: z.string().optional(),
    layer: MemoryLayerSchema,
    text: z.string(),
    sessionId: z.string().optional(),
    meta: z.record(z.string(), z.unknown()).optional(),
  });
  app.get("/memory", async (req) => {
    const q = req.query as { scope?: string; layer?: string; sessionId?: string };
    return {
      items: await memory.list({
        ...(q.scope ? { scope: q.scope } : {}),
        ...(q.layer ? { layer: q.layer as never } : {}),
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

  // ---- 记忆向量召回（本地 CPU embedding）----
  app.get("/memory/embedding", async () => embeddings.info);
  app.post("/memory/embedding", async (req) => {
    const body = (req.body ?? {}) as { repoId?: string; fileName?: string; modelPath?: string };
    const modelPath =
      body.modelPath ??
      (await downloadEmbeddingModel(body.repoId ?? DEFAULT_EMBED_REPO, body.fileName ?? DEFAULT_EMBED_FILE));
    const { dim } = await embeddings.setModel(modelPath);
    const reindexed = await memory.reindex();
    saveEmbedSetting(modelPath);
    return { ...embeddings.info, dim, reindexed };
  });

  // ---- OpenAI/Anthropic 兼容端点（复用同一 registry） ----
  // 本地模型透传到 router；云端流式经 pi-ai（统一 ModelRegistry/AuthStorage）。
  registerOpenAICompat(app, registry, {
    localBaseUrl: (m) => local.baseUrlFor(m),
    localApiKey: () => local.getApiKey(),
    cloudStream: (modelId, context, opts) => sessionHost.streamCloud(modelId, context, opts),
    completeCloud: (modelId, context, opts) => sessionHost.completeCloud(modelId, context, opts),
  });

  return {
    app,
    registry,
    local,
    models,
    providers,
    skills,
    mcp,
    memory,
    embeddings,
    kb,
    repo,
    token,
    async start(startOpts = {}) {
      const host = startOpts.host ?? "127.0.0.1";
      const port = startOpts.port ?? 0;
      await app.listen({ port, host });
      const addr = app.server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      // 启动后台自动启用向量记忆（不阻塞 listen）。
      void autoEnableEmbedding();
      return { port: actualPort, host };
    },
    async stop() {
      await app.close();
      stopMemWatch();
      // 停模型前先 flush 待抽取的记忆（抽取要用模型；停了就抽不成）。
      await sessionHost.flushAllExtraction().catch(() => {});
      try {
        sessionHost.disposeAll();
      } catch {
        /* ignore */
      }
      await local.stopAll().catch(() => {});
      await embeddings.stop().catch(() => {});
      try {
        repo.close();
      } catch {
        /* ignore */
      }
      try {
        memory.close();
      } catch {
        /* ignore */
      }
      try {
        kb.close();
      } catch {
        /* ignore */
      }
    },
  };
}

/** 目录是否存在且为目录。 */
/**
 * 默认工作区下下一个可用的 NewProject{N} 路径（仅计算，不创建目录——真正聊天时才落盘）。
 * 避重需同时看已有项目记录与磁盘目录：未聊天的项目目录尚不存在，仅靠 fs 会重号。
 */
function nextNewProjectDir(repo: SqliteConversationRepo): string {
  const root = defaultWorkspaceDir();
  const used = new Set<number>();
  for (const p of repo.listProjects()) {
    const m = p.workspaceDir ? /(?:^|[\\/])NewProject(\d+)$/.exec(p.workspaceDir) : null;
    if (m) used.add(Number(m[1]));
  }
  try {
    for (const e of fs.readdirSync(root)) {
      const m = /^NewProject(\d+)$/.exec(e);
      if (m) used.add(Number(m[1]));
    }
  } catch {
    /* root 可能尚不存在 */
  }
  let n = 1;
  while (used.has(n)) n++;
  return fsPath.join(root, `NewProject${n}`);
}

/** 解析 sqlite-vec 可加载扩展路径（记忆语义召回唯一引擎）。平台无预编译二进制时返回 undefined → 召回退化为纯词法。 */
function resolveVecExtensionPath(): string | undefined {
  // 打包（Node SEA）后无 node_modules → getLoadablePath 解析失败。优先 EW_SQLITE_VEC，
  // 再尝试可执行文件同目录随附的 vec0.{dylib,so,dll}（单文件二进制发布形态）。
  const fromEnv = process.env.EW_SQLITE_VEC;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const ext = process.platform === "win32" ? "vec0.dll" : process.platform === "darwin" ? "vec0.dylib" : "vec0.so";
  const beside = fsPath.join(fsPath.dirname(process.execPath), ext);
  if (fs.existsSync(beside)) return beside;
  try {
    const req = createRequire(import.meta.url);
    const sv = req("sqlite-vec") as { getLoadablePath?: () => string };
    return sv.getLoadablePath?.();
  } catch {
    return undefined;
  }
}

function isExistingDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 取本机第一个非内部 IPv4（绑定 0.0.0.0 时供其他设备直连 router）。 */
function lanIPv4(): string | undefined {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === "IPv4" && !ni.internal) return ni.address;
    }
  }
  return undefined;
}

// 记忆清单（渐进式披露）构造在 agent/ew-extensions.ts；此处再导出供测试/外部复用。
export { buildMemoryManifest } from "../agent/ew-extensions.js";
