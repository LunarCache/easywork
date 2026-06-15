import fs from "node:fs";
import fsPath from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import {
  ChatMessageSchema,
  ChatRequestSchema,
  ApprovalModeSchema,
  GGUFVariantSchema,
  LocalLoadOptionsSchema,
  McpServerConfigSchema,
  SamplingParamsSchema,
  messageText,
  normalizeContent,
  type AgentEvent,
  type ChatStreamEvent,
  type DownloadEvent,
  type McpServerConfig,
  type MemoryLayer,
  type MemoryProvider,
  type Project,
  type Tool,
} from "@ew/shared";
import { LlamaServerEngine } from "@ew/providers";
import { builtinTools } from "@ew/tools";
import { SkillManager } from "@ew/skills";
import { McpClientManager } from "@ew/mcp";
import { LocalMemoryProvider } from "@ew/memory";
import { z } from "zod";
import { EngineRegistry } from "../engine/registry.js";
import { ModelManager } from "../models/manager.js";
import { ProviderManager, type CloudProviderConfig } from "../providers/manager.js";
import { registerOpenAICompat } from "../openai-compat/router.js";
import { ToolRegistry } from "../agent/tool-registry.js";
import { runAgent } from "../agent/loop.js";
import { runAgentPi } from "../agent/pi/run-agent-pi.js";
import { resolvePiModel } from "../ai/pi-models.js";
import { ToolTurnRecorder } from "../agent/turn-recorder.js";
import { ApprovalRegistry, SseApprovalGate } from "../agent/approval-sse.js";
import { SqliteConversationRepo } from "../store/conversation.js";
import { EmbeddingService } from "../memory/embedding-service.js";
import { buildFactExtractor } from "../memory/fact-extractor.js";
import { makeMemoryTool } from "../memory/memory-tool.js";
import { makeSessionSearchTool } from "../memory/session-search-tool.js";
import { workspaceTools } from "../agent/workspace-approval.js";
import { GitService } from "../git/git.js";
import { listDir, readFileSafe } from "@ew/tools";
import { KnowledgeBaseStore } from "../rag/store.js";
import { makeSearchKnowledgeBaseTool, ragAutoInject } from "../rag/tool.js";
import { parseFile } from "../rag/parse.js";
import { LocalServerManager, getFreePort } from "../engine/local-server-manager.js";
import {
  dataDir as defaultDataDir,
  dbPath as defaultDbPath,
  memoryDir as defaultMemoryDir,
  modelsDir as defaultModelsDir,
  defaultWorkspaceDir,
} from "../config/paths.js";

export interface CoreServer {
  app: FastifyInstance;
  registry: EngineRegistry;
  local: LocalServerManager;
  models: ModelManager;
  providers: ProviderManager;
  tools: ToolRegistry;
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
  /** llama-server 可执行文件路径（默认走 PATH 中的 "llama-server"）。 */
  llamaServerPath?: string;
}

const ProviderConfigSchema = z.object({
  id: z.string(),
  baseUrl: z.string().url(),
  apiKey: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  models: z.array(z.string()),
});

/** 创建核心守护进程（Fastify server + 引擎/模型/provider 管理）。 */
export function createCore(opts: CreateCoreOptions = {}): CoreServer {
  const token = opts.token ?? crypto.randomUUID();
  const llamaBin = opts.llamaServerPath ?? process.env.EW_LLAMA_SERVER;
  const registry = new EngineRegistry();
  // 本地推理：每个模型一个 llama-server 子进程（文本/视觉统一，取代 node-llama-cpp）。
  const local = new LocalServerManager(registry, llamaBin ? { binaryPath: llamaBin } : {});

  const models = new ModelManager({
    modelsDir: opts.modelsDir ?? defaultModelsDir(),
    extraDirs: opts.extraModelDirs,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  const providers = new ProviderManager(registry, opts.fetch ? { fetch: opts.fetch } : {});

  // Agent 运行时：工具注册表（内置工具 + Skills/MCP 动态 provider）。
  const workspaceDir = opts.workspaceDir ?? defaultDataDir();
  const skillsDirs = opts.skillsDirs ?? [fsPath.join(defaultDataDir(), "skills")];
  const tools = new ToolRegistry();
  for (const t of builtinTools) tools.register(t);
  const skills = new SkillManager(skillsDirs);
  const mcp = new McpClientManager();
  tools.addProvider("skills", skills.toolProvider());
  tools.addProvider("mcp", mcp.toolProvider());
  // 交互式审批跨请求登记表（/agent/run 挂起 ↔ /agent/approve 解析）。
  const approvalRegistry = new ApprovalRegistry();

  // 本地 CPU embedding 服务（参考 Hermes：nomic-embed-text 语义召回）。经 llama-server --embedding 运行。
  const embeddings = new EmbeddingService({
    makeEngine: async (modelPath) => {
      const port = await getFreePort();
      return new LlamaServerEngine({
        id: "embed",
        modelPath,
        embedding: true,
        port,
        ...(llamaBin ? { binaryPath: llamaBin } : {}),
      });
    },
  });
  const memory = new LocalMemoryProvider({
    dir: opts.memoryDir ?? defaultMemoryDir(),
    dbPath: opts.memoryDbPath ?? `${defaultDataDir()}/memory.db`,
    embed: (texts) => embeddings.embed(texts),
    // 轮后用当轮对话模型抽取持久事实写入全局层（复用已加载模型）。
    extract: buildFactExtractor({ resolveEngine: (m) => registry.resolve(m) }),
  });
  // markdown 为真相源：监听用户手工编辑并回灌索引（内存库/测试不监听）。
  const stopMemWatch =
    (opts.memoryDbPath ?? "") === ":memory:" ? () => {} : memory.startWatching();

  // 文档知识库 RAG：分块 + 嵌入 + 混合检索；非空时暴露 search_knowledge_base 工具。
  const kb = new KnowledgeBaseStore({
    dbPath: opts.kbDbPath ?? `${defaultDataDir()}/kb.db`,
    embed: (texts) => embeddings.embed(texts),
  });
  // search_knowledge_base 工具按请求所选集合注入（见 /agent/run），不再全局常驻。

  const repo = new SqliteConversationRepo(opts.dbPath ?? defaultDbPath());

  // ---- 持久化 provider / MCP 配置（重启后恢复）----
  const PROVIDERS_KEY = "providers";
  const MCP_KEY = "mcp.servers";
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
  } catch {
    /* 损坏的配置忽略 */
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
  const modelsDirPath = opts.modelsDir ?? defaultModelsDir();
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
    reply.header("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
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
    context: local.contexts(),
    engines: registry.list().map((e) => ({ id: e.id, capabilities: e.capabilities })),
  }));

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
    return { ok: true };
  });

  app.delete("/providers/:id", async (req) => {
    providers.remove((req.params as { id: string }).id);
    persistProviders();
    return { ok: true };
  });

  // ---- 流式对话（内部 SSE，渠道无关事件） ----
  app.post("/chat/stream", async (req, reply) => {
    const parsed = ChatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", detail: parsed.error.format() });
    }
    let engine;
    try {
      engine = registry.resolve(parsed.data.model);
    } catch (err) {
      return reply.code(404).send({ error: "model_not_loaded", message: String(err) });
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
    const send = (ev: ChatStreamEvent) => raw.write(`data: ${JSON.stringify(ev)}\n\n`);
    try {
      for await (const ev of engine.chatStream({ ...parsed.data, signal: ac.signal })) {
        send(ev);
      }
    } catch (err) {
      send({ type: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      raw.write("data: [DONE]\n\n");
      raw.end();
    }
  });

  // ---- Agent 运行（工具/Skills/MCP 循环，SSE 发 AgentEvent） ----
  const AgentRunSchema = z.object({
    threadId: z.string().default("default"),
    model: z.string(),
    history: z.array(ChatMessageSchema),
    maxIterations: z.number().int().positive().optional(),
    excludeTools: z.array(z.string()).optional(),
    think: z.boolean().optional(),
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

    // 热重载 Skills，并把技能目录注入系统提示。
    await skills.discover().catch(() => {});
    const catalog = skills.systemPromptCatalog();
    const history = catalog
      ? [{ role: "system" as const, content: catalog }, ...parsed.data.history]
      : [...parsed.data.history];
    // 记忆工具（manage_memory：模型自治增改删）+ 会话检索（session_search：FTS5 历史）常驻。
    const extraTools: Tool[] = [makeMemoryTool(memory), makeSessionSearchTool(repo)];
    // RAG：仅当聊天开启「知识库」时启用——自动注入相关上下文，并按所选集合注入 search_knowledge_base 工具。
    const useKb = parsed.data.kb === true;
    const kbId = parsed.data.kbId;
    if (useKb) {
      extraTools.push(makeSearchKnowledgeBaseTool(kb, kbId));
      const lu = parsed.data.history[parsed.data.history.length - 1];
      const q = lu?.role === "user" ? messageText(lu.content) : "";
      if (q) {
        const inj = await ragAutoInject(kb, q, kbId ? { kbId } : {}).catch(() => null);
        if (inj) history.unshift({ role: "system" as const, content: inj.context });
      }
    }
    // 冻结快照（参考 Hermes）：会话期间固定的全局记忆作为系统块置顶注入，护 prefix cache。
    // 历史检索交给 session_search（FTS5），故关闭动态 recall（见下方 recallOptions）。
    const snapshot = await buildMemorySnapshot(memory);
    if (snapshot) history.unshift({ role: "system" as const, content: snapshot });
    // Think 开关：把 /think 或 /no_think 注入给模型（Qwen3 等），但不污染持久化的用户消息。
    if (parsed.data.think !== undefined && history.length > 0) {
      const last = history[history.length - 1]!;
      if (last.role === "user") {
        const directive = parsed.data.think ? " /think" : " /no_think";
        history[history.length - 1] = { ...last, content: `${messageText(last.content)}${directive}` };
      }
    }

    // 工作区：按 projectId 解析项目根 + 审批策略；注入 fs/exec 工具与项目指令（含 AGENTS.md）。
    const threadId = parsed.data.threadId;
    const projectId = parsed.data.projectId ?? repo.getThread(threadId)?.projectId ?? undefined;
    const project = projectId ? repo.getProject(projectId) : null;
    let runWorkspaceDir = workspaceDir;
    if (project?.workspaceDir) {
      runWorkspaceDir = project.workspaceDir;
      extraTools.push(...workspaceTools(project.approvalMode ?? "approve-each"));
      const instr = workspaceInstructions(project);
      if (instr) history.unshift({ role: "system" as const, content: instr });
    }

    // 持久化（应用内会话历史）：确保 thread 存在并追加本轮用户消息。
    const lastUser = parsed.data.history[parsed.data.history.length - 1];
    if (!repo.getThread(threadId)) {
      const title = lastUser ? messageText(lastUser.content).slice(0, 40) || "新会话" : "新会话";
      repo.createThread({
        id: threadId,
        modelId: parsed.data.model,
        title,
        ...(projectId ? { projectId } : {}),
      });
    }
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
    let finalContent = "";

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
    const send = (ev: AgentEvent) => raw.write(`data: ${JSON.stringify(ev)}\n\n`);
    // 交互式审批门：危险工具经 SSE approval-request 事件挂起，等 /agent/approve 解析。
    const runApproval = new SseApprovalGate({
      registry: approvalRegistry,
      emit: (ev) => send(ev),
      signal: ac.signal,
    });
    // 从事件流重建并持久化 agent loop 的工具往返（对齐 Hermes：完整历史含 tool_calls/results）。
    const recorder = new ToolTurnRecorder();
    const persistRecorded = (msgs: ReturnType<ToolTurnRecorder["push"]>): void => {
      for (const m of msgs) {
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
    };

    const runInput = {
      threadId: parsed.data.threadId,
      model: parsed.data.model,
      history,
      ...(parsed.data.maxIterations ? { maxIterations: parsed.data.maxIterations } : {}),
      ...(parsed.data.excludeTools ? { excludeTools: parsed.data.excludeTools } : {}),
      ...(parsed.data.sampling ? { sampling: parsed.data.sampling } : {}),
      signal: ac.signal,
    };
    // 内核选择：EW_AGENT_KERNEL=pi 走 pi-agent-core；否则现有 loop（默认）。两者都产出我们的 AgentEvent。
    let agentEvents: AsyncIterable<AgentEvent>;
    if (process.env.EW_AGENT_KERNEL === "pi") {
      const toolCtx = { sessionId: threadId, workspaceDir: runWorkspaceDir, signal: ac.signal, approval: runApproval };
      const exclude = new Set(parsed.data.excludeTools ?? []);
      const toolList = [...(await tools.list(toolCtx)), ...extraTools].filter(
        (t) => !exclude.has(t.definition.name),
      );
      agentEvents = runAgentPi(runInput, {
        resolveModel: (m) =>
          resolvePiModel(m, {
            localBaseUrl: (id) => local.baseUrlFor(id),
            cloudProvider: (id) => providers.findByModel(id),
          }),
        tools: toolList,
        approval: runApproval,
        workspaceDir: runWorkspaceDir,
        ...(memory ? { memory } : {}),
        mutatingTools: new Set(["fs_write", "fs_edit", "run_command", "manage_memory"]),
      });
    } else {
      agentEvents = runAgent(runInput, {
        resolveEngine: (m) => registry.resolve(m),
        tools,
        approval: runApproval,
        workspaceDir: runWorkspaceDir,
        memory,
        // 全局记忆已由冻结快照置顶注入、历史由 session_search 检索；关闭动态 recall 避免重复注入。
        recallOptions: { enabled: false },
        // 工具中间进度（run_command 流式输出）直接写 SSE。
        onToolProgress: (ev) => send(ev),
        ...(extraTools.length ? { extraTools } : {}),
      });
    }

    try {
      for await (const ev of agentEvents) {
        persistRecorded(recorder.push(ev));
        if (ev.type === "final") finalContent = messageText(ev.message.content);
        send(ev);
      }
      // 追加助手最终回复（无工具的收尾轮）。
      if (finalContent) {
        repo.appendMessage({
          id: crypto.randomUUID(),
          threadId,
          role: "assistant",
          seq: repo.nextSeq(threadId),
          parts: [{ type: "text", text: finalContent }],
          createdAt: new Date().toISOString(),
        });
      }
    } catch (err) {
      send({ type: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      raw.write("data: [DONE]\n\n");
      raw.end();
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
    return { ok: true };
  });
  app.delete("/mcp/servers/:id", async (req) => {
    await mcp.remove((req.params as { id: string }).id);
    persistMcp();
    return { ok: true };
  });
  app.post("/mcp/probe", async (req, reply) => {
    const parsed = McpServerConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_config", detail: parsed.error.format() });
    }
    return mcp.probe(parsed.data);
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
  app.get("/threads", async () => ({ threads: repo.listThreads() }));
  app.get("/threads/:id/messages", async (req) => ({
    messages: repo.history((req.params as { id: string }).id),
  }));
  app.delete("/threads/:id", async (req) => {
    repo.deleteThread((req.params as { id: string }).id);
    return { ok: true };
  });

  // ---- 工作区项目（Project = 本地目录 + 审批策略） ----
  const ProjectCreateSchema = z.object({
    name: z.string().min(1),
    workspaceDir: z.string().optional(),
    approvalMode: ApprovalModeSchema.optional(),
    instructions: z.string().optional(),
  });
  const ProjectPatchSchema = ProjectCreateSchema.partial();

  app.get("/projects", async () => ({ projects: repo.listProjects() }));
  app.post("/projects", async (req, reply) => {
    const parsed = ProjectCreateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_project", detail: parsed.error.format() });
    // 未指定目录 → 在数据目录下用专门的默认工作区目录（自动创建）。
    const workspaceDir = parsed.data.workspaceDir?.trim() || defaultWorkspaceDir();
    if (parsed.data.workspaceDir && !isExistingDir(parsed.data.workspaceDir)) {
      return reply.code(400).send({ error: "invalid_dir", message: "workspaceDir 不是有效目录" });
    }
    return repo.createProject({ ...parsed.data, workspaceDir });
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
    repo.deleteProject((req.params as { id: string }).id);
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
      return { entries: listDir(projectRoot(id), q.path ?? ".", q.depth ? Number(q.depth) : 1) };
    } catch (e) {
      return reply.code(400).send({ error: "fs_error", message: e instanceof Error ? e.message : String(e) });
    }
  });
  app.get("/workspace/:id/fs/read", async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { path?: string; start?: string; end?: string };
    if (!q.path) return reply.code(400).send({ error: "path_required" });
    try {
      return readFileSafe(projectRoot(id), q.path, {
        ...(q.start ? { start: Number(q.start) } : {}),
        ...(q.end ? { end: Number(q.end) } : {}),
      });
    } catch (e) {
      return reply.code(400).send({ error: "fs_error", message: e instanceof Error ? e.message : String(e) });
    }
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

  // ---- 记忆 ----
  const MemoryWriteSchema = z.object({
    layer: z.enum(["user-profile", "agent-memory", "skills"]),
    text: z.string(),
    sessionId: z.string().optional(),
    meta: z.record(z.string(), z.unknown()).optional(),
  });
  app.get("/memory", async (req) => {
    const q = req.query as { layer?: string; sessionId?: string };
    return {
      items: await memory.list({
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

  // 召回（调试/检视；带相关度分数）。
  app.get("/memory/recall", async (req, reply) => {
    const q = req.query as { q?: string; topK?: string; sessionId?: string };
    if (!q.q) return reply.code(400).send({ error: "missing_query" });
    return {
      hits: await memory.recall({
        query: q.q,
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

  // ---- OpenAI 兼容端点（复用同一 registry） ----
  registerOpenAICompat(app, registry);

  return {
    app,
    registry,
    local,
    models,
    providers,
    tools,
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
function isExistingDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 工作区项目指令：project.instructions + 项目根的 AGENTS.md（若存在），拼成系统块。 */
function workspaceInstructions(project: Project): string {
  const parts: string[] = [];
  if (project.instructions?.trim()) parts.push(project.instructions.trim());
  if (project.workspaceDir) {
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      try {
        const txt = fs.readFileSync(fsPath.join(project.workspaceDir, name), "utf8");
        if (txt.trim()) {
          parts.push(`# ${name}\n${txt.trim()}`);
          break;
        }
      } catch {
        /* 不存在则跳过 */
      }
    }
  }
  if (parts.length === 0) return "";
  return `你正在工作区「${project.name}」（目录：${project.workspaceDir}）中工作。可用 fs_* 工具读写文件、run_command 执行命令（路径限定在工作区内）。\n\n${parts.join("\n\n")}`;
}

/** 构造全局记忆的冻结快照系统块（参考 Hermes）：会话期固定，置顶注入。全空则返回 ""。 */
export async function buildMemorySnapshot(memory: MemoryProvider): Promise<string> {
  const layers: { layer: MemoryLayer; title: string }[] = [
    { layer: "user-profile", title: "用户画像" },
    { layer: "agent-memory", title: "长期记忆" },
    { layer: "skills", title: "技能/流程" },
  ];
  const blocks: string[] = [];
  for (const { layer, title } of layers) {
    const items = await memory.list({ layer });
    if (items.length === 0) continue;
    blocks.push(`## ${title}\n${items.map((i) => `- ${i.text}`).join("\n")}`);
  }
  if (blocks.length === 0) return "";
  return `以下是你的持久记忆（本次会话期间固定；需变更请用 manage_memory 工具）：\n\n${blocks.join("\n\n")}`;
}
