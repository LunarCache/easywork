import fs from "node:fs";
import fsPath from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import Fastify, { type FastifyInstance } from "fastify";
import {
  messageText,
  ChannelConfigSchema,
  type ChannelConfig,
  type McpServerConfig,
  type MemoryProvider,
} from "@ew/shared";
import { LlamaServeEngine } from "@ew/providers";
import { builtinTools } from "@ew/tools";
import { SkillManager, type SkillSourceConfig } from "@ew/skills";
import { McpClientManager } from "@ew/mcp";
import {
  type ChannelGateway,
  ChannelAdapterRegistry,
  registerBuiltInChannelAdapters,
  registerFeishuApp,
  registerWechatAccount,
} from "@ew/im-connectors";
import { AdditiveMemoryProvider, LocalMemoryProvider } from "@ew/memory";
import { z } from "zod";
import { EngineRegistry } from "../engine/registry.js";
import { ModelManager } from "../models/manager.js";
import { LocalModelSettingsStore } from "../models/local-model-settings.js";
import { ProviderManager, type CloudProviderConfig } from "../providers/manager.js";
import { registerOpenAICompat } from "../openai-compat/router.js";
import { SessionHost } from "../agent/session-host.js";
import { AgentTurnLifecycle } from "../agent/turn-lifecycle.js";
import { SqliteConversationRepo } from "../store/conversation.js";
import { EmbeddingService } from "../memory/embedding-service.js";
import { buildFactExtractor } from "../memory/fact-extractor.js";
import { RouterServerManager } from "../engine/router-server-manager.js";
import { getFreePort } from "../engine/net.js";
import type { LocalBackend } from "../engine/local-backend.js";
import { resolveLlamaBin } from "../engine/resolve-llama.js";
import { ChannelOperations, stripChannelSecrets } from "../channels/operations.js";
import {
  createChannelSecretStore,
  MemoryChannelSecretStore,
  type ChannelSecretStore,
} from "../channels/secret-store.js";
import type { CoreHttpContext } from "./context.js";
import type { RawBodyRequest } from "./http-utils.js";
import { registerAgentRoutes } from "./routes/agent.js";
import { registerModelRoutes } from "./routes/models.js";
import { registerProviderRoutes } from "./routes/providers.js";
import { registerChannelRoutes } from "./routes/channels.js";
import { registerSkillRoutes } from "./routes/skills.js";
import { registerMcpRoutes } from "./routes/mcp.js";
import { registerMemoryRoutes } from "./routes/memory.js";
import { registerSkillLearningRoutes } from "./routes/skill-learning.js";
import { registerWorkspaceRoutes } from "./routes/workspace.js";
import {
  dataDir as defaultDataDir,
  dbPath as defaultDbPath,
  memoryDir as defaultMemoryDir,
  modelsDir as defaultModelsDir,
} from "../config/paths.js";
import { SkillCandidateLifecycle } from "../skill-learning/candidate-service.js";
import {
  createSourceConversationLifecycle,
  type SourceConversationLifecycle,
} from "../conversations/source-conversation-lifecycle.js";

export { agentModelUnavailableError } from "./routes/agent.js";

export interface CoreServer {
  app: FastifyInstance;
  registry: EngineRegistry;
  local: LocalBackend;
  models: ModelManager;
  providers: ProviderManager;
  skills: SkillManager;
  mcp: McpClientManager;
  channels: ChannelGateway;
  memory: LocalMemoryProvider;
  agentMemory: AdditiveMemoryProvider;
  embeddings: EmbeddingService;
  repo: SqliteConversationRepo;
  sourceConversations: SourceConversationLifecycle;
  agentTurns: AgentTurnLifecycle;
  token: string;
  start(opts?: { port?: number; host?: string }): Promise<{ port: number; host: string }>;
  stop(): Promise<void>;
}

export interface CreateCoreOptions {
  token?: string;
  /** 覆盖模型目录（测试用）。 */
  modelsDir?: string;
  extraModelDirs?: string[];
  /** Skills 发现目录（测试/覆盖用；默认使用 pi 全局目录与标准全局目录）。 */
  skillsDirs?: string[];
  /** agent 工具沙箱工作目录（默认 dataDir）。 */
  workspaceDir?: string;
  /** pi Agent 配置与会话目录（测试/嵌入覆盖用）。 */
  agentDir?: string;
  /** Skill Candidate / learned Skill 结构化状态库。 */
  skillLearningDbPath?: string;
  /** 可选 Deep Memory provider；仅 additive recall，永不替换本地 Core Memory。 */
  deepMemoryProvider?: MemoryProvider;
  /** 会话 SQLite 路径（测试可传 ":memory:"）。 */
  dbPath?: string;
  /** 记忆 markdown 目录。 */
  memoryDir?: string;
  /** 记忆索引 SQLite 路径（测试可传 ":memory:"）。 */
  memoryDbPath?: string;
  /** 覆盖 fetch（测试用，拦截 HF / 云端调用）。 */
  fetch?: typeof fetch;
  /** 覆盖 Feishu/Lark 扫码注册（测试用，避免真实外网轮询）。 */
  feishuRegister?: typeof registerFeishuApp;
  /** 覆盖 WeChat/iLink 扫码注册（测试用，避免真实外网轮询）。 */
  wechatRegister?: typeof registerWechatAccount;
  /** 渠道密钥存储（测试可注入内存实现；生产默认使用系统安全存储）。 */
  channelSecretStore?: ChannelSecretStore;
  /** 统一 `llama`（llama.app）可执行文件路径（默认走 PATH 中的 "llama"）。 */
  llamaBinPath?: string;
}

const BODY_LIMIT_BYTES = 32 * 1024 * 1024;

function requestBodyTooLargeError(): Error & { statusCode?: number; code?: string } {
  const err = new Error("request body too large") as Error & { statusCode?: number; code?: string };
  err.statusCode = 413;
  err.code = "FST_ERR_CTP_BODY_TOO_LARGE";
  return err;
}

function uniqSkillSources(sources: SkillSourceConfig[]): SkillSourceConfig[] {
  const seen = new Set<string>();
  const out: SkillSourceConfig[] = [];
  for (const source of sources) {
    const resolved = fsPath.resolve(source.dir);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push({ ...source, dir: resolved });
  }
  return out;
}

function defaultSkillSources(agentDir: string): SkillSourceConfig[] {
  const home = os.homedir();
  const agentsHome = process.env.AGENTS_HOME || fsPath.join(home, ".agents");
  return uniqSkillSources([
    {
      id: "builtin",
      label: "内置 Skills",
      kind: "builtin",
      dir: fsPath.join(agentDir, "skills"),
      primary: true,
    },
    {
      id: "agents",
      label: "标准目录",
      kind: "agents",
      dir: fsPath.join(agentsHome, "skills"),
    },
  ]);
}

function skillSourcesFromDirs(dirs: string[]): SkillSourceConfig[] {
  return uniqSkillSources(
    dirs.map((dir, index) => ({
      id: index === 0 ? "builtin" : `custom-${index + 1}`,
      label: index === 0 ? "内置 Skills" : `全局目录 ${index + 1}`,
      kind: index === 0 ? "builtin" : "custom",
      dir,
      ...(index === 0 ? { primary: true } : {}),
    })),
  );
}

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

  // Agent 运行时：内置工具（时间/计算器/HTTP/explore_web）由宿主桥成 pi customTools；
  // Skills 由 pi 自身发现（resourceLoader）；MCP 由宿主桥成 customTools。
  const agentDir = opts.agentDir ?? fsPath.join(defaultDataDir(), "pi-agent");
  const skillSources = opts.skillsDirs ? skillSourcesFromDirs(opts.skillsDirs) : defaultSkillSources(agentDir);
  const skills = new SkillManager(skillSources);
  const mcp = new McpClientManager();
  const channelRegistry = registerBuiltInChannelAdapters(new ChannelAdapterRegistry());

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
  const agentMemory = new AdditiveMemoryProvider(memory, opts.deepMemoryProvider);
  // markdown 为真相源：监听用户手工编辑并回灌索引（内存库/测试不监听）。
  const stopMemWatch =
    (opts.memoryDbPath ?? "") === ":memory:" ? () => {} : memory.startWatching();

  const repo = new SqliteConversationRepo(opts.dbPath ?? defaultDbPath());
  const channelSecretStore = opts.channelSecretStore
    ?? ((opts.dbPath ?? defaultDbPath()) === ":memory:"
      ? new MemoryChannelSecretStore()
      : createChannelSecretStore(defaultDataDir()));
  const localModelSettings = new LocalModelSettingsStore(repo);

  // 宿主：pi-coding-agent 内核托管 /agent/run。
  // R3：注入记忆/会话检索/MCP，使托管会话具备 EasyWork 专有能力。
  const sessionHost = new SessionHost({
    local,
    providers,
    agentDir,
    globalSkillPaths: skillSources.map((source) => source.dir),
    memory: agentMemory,
    repo,
    mcp,
    builtins: builtinTools,
    localModelSettings,
  });
  const primarySkillSource = skillSources.find((source) => source.primary) ?? skillSources[0];
  const skillsDir = primarySkillSource?.dir ?? fsPath.join(agentDir, "skills");
  const skillLifecycle = new SkillCandidateLifecycle({
    dbPath: opts.skillLearningDbPath ?? fsPath.join(defaultDataDir(), "skill-learning.db"),
    skills,
    skillsDir,
    repo,
    sessionInvalidator: sessionHost,
    archiveDir: fsPath.join(fsPath.dirname(agentDir), "skill-archive"),
    knownTools: () => [
      "read", "write", "edit", "bash", "grep", "find", "ls",
      "manage_memory", "recall_memory", "session_search", "stage_skill_candidate",
      ...builtinTools.map((tool) => tool.definition.name),
    ],
    reviewer: async ({ trajectory, catalog }, model) => {
      let engine;
      try {
        engine = registry.resolve(model);
      } catch {
        return null;
      }
      const response = await engine.chat({
        model,
        temperature: 0,
        maxTokens: 1800,
        responseFormat: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You are a restricted Skill reviewer. You have read-only trajectory and catalog data and no tools. " +
              "Return JSON {action:'nothing'} unless the successful work contains a genuinely reusable procedure. " +
              "Prefer patching the used/class-level Skill over a narrow new Skill. Never include facts, secrets, logs, temporary paths, or policy overrides. " +
              "For a candidate return {action:'candidate', candidate:{name,description,triggerConditions,scope,workspaceId?,proposedSkillMd,packageFiles?,requiredTools,sourceThreadIds,evidence,reason,createdBy:'background-learning',baseSkillId?,baseContentHash?}}. " +
              "SKILL.md must contain frontmatter plus Procedure, Pitfalls, and Verification sections.",
          },
          {
            role: "user",
            content: JSON.stringify({ trajectory, catalog }),
          },
        ],
      });
      const raw = messageText(response.message.content);
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      if (start < 0 || end <= start) return null;
      const parsed = JSON.parse(raw.slice(start, end + 1)) as { action?: string; candidate?: unknown };
      return parsed.action === "candidate" ? (parsed.candidate as never) : null;
    },
  });
  const sourceConversations = createSourceConversationLifecycle(sessionHost, memory, skillLifecycle, repo);
  const agentTurns = new AgentTurnLifecycle({ repo, sourceConversations, sessionHost, skillLifecycle });
  skills.setOpenListener((skill) => skillLifecycle.recordUseByPath(skill.bodyPath));
  sessionHost.setSkillCandidateStager((input) => skillLifecycle.stage(input));
  // 一次性收口旧 global.skills：程序化条目进入待审核候选，事实进入 Agent Notes，歧义项只读保留。
  for (const legacy of memory.listLegacySkillMemory().filter((item) => !item.disposition)) {
    const procedural = /(?:^|\s)(?:npm|pnpm|yarn|git|docker|curl|python|node)\s|(?:先|然后|步骤|流程|运行|执行|命令)/i.test(legacy.text);
    const factual = /用户|偏好|项目|环境|部署在|路径|使用|版本/.test(legacy.text);
    try {
      if (procedural) {
        const name = `legacy-${legacy.id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "workflow"}`;
        skillLifecycle.stage({
          name,
          description: "Imported legacy procedural memory pending review",
          triggerConditions: ["when the imported legacy workflow is relevant"],
          scope: "global",
          proposedSkillMd: `---\nname: ${name}\ndescription: Imported legacy procedural memory pending review\nwhenToUse: when the imported legacy workflow is relevant\nversion: "0.1.0"\n---\n\n# Imported workflow\n\n## Procedure\n\n${legacy.text}\n\n## Pitfalls\n\n- Review and generalize this migrated content before approval.\n\n## Verification\n\n- Confirm the procedure against the current environment.\n`,
          requiredTools: [],
          sourceThreadIds: legacy.sourceThreadId ? [legacy.sourceThreadId] : [],
          evidence: legacy.sourceThreadId ? [{ sourceThreadId: legacy.sourceThreadId, summary: legacy.text.slice(0, 160) }] : [],
          reason: "Migrated from the removed global.skills memory layer",
          createdBy: "migration",
        });
        memory.markLegacySkillMemory(legacy.id, "candidate");
      } else if (factual) {
        void memory
          .write({ layer: "agent-notes", text: legacy.text, origin: "imported", state: "curated", meta: { migratedFrom: "global.skills", legacyId: legacy.id } })
          .then(() => memory.markLegacySkillMemory(legacy.id, "agent-note"))
          .catch(() => {});
      } else {
        memory.markLegacySkillMemory(legacy.id, "ambiguous");
      }
    } catch {
      // 留在 disposition=NULL，下一次启动可重试；绝不直接激活为 Skill。
    }
  }

  // ---- 持久化 provider / MCP 配置（重启后恢复）----
  const PROVIDERS_KEY = "providers";
  const MCP_KEY = "mcp.servers";
  const CHANNELS_KEY = "im.connectors";
  const LOCAL_BIND_KEY = "local.bindHost";
  const LOCAL_APIKEY_KEY = "local.apiKey";
  const HF_MIRROR_KEY = "models.hf.useMirror";
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
  try {
    models.setHfMirrorEnabled(repo.getSetting(HF_MIRROR_KEY) === "true");
  } catch {
    /* 损坏或不可读设置回退官方源 */
  }
  void (async () => {
    try {
      const raw = repo.getSetting(MCP_KEY);
      if (raw) for (const c of JSON.parse(raw) as McpServerConfig[]) await mcp.upsert(c);
    } catch {
      /* 损坏的配置忽略 */
    }
  })();

  const loadChannelConfigs = (): ChannelConfig[] => {
    let configs: ChannelConfig[];
    try {
      const raw = repo.getSetting(CHANNELS_KEY);
      if (!raw) return [];
      const parsed = z.array(ChannelConfigSchema).safeParse(JSON.parse(raw));
      if (!parsed.success) return [];
      configs = parsed.data;
    } catch {
      return [];
    }
    let migrated = false;
    const hydrated = configs.map((config) => {
      const legacySecrets = Object.fromEntries(Object.entries(config.secrets).filter(([, value]) => Boolean(value)));
      const storedSecrets = channelSecretStore.get(config.id);
      const secrets = { ...storedSecrets, ...legacySecrets };
      if (Object.keys(legacySecrets).length) {
        channelSecretStore.set(config.id, secrets);
        migrated = true;
      }
      return { ...config, secrets };
    });
    if (migrated) repo.setSetting(CHANNELS_KEY, JSON.stringify(hydrated.map(stripChannelSecrets)));
    return hydrated;
  };
  const resolveChannelModel = (): string | undefined => registry.routedModels()[0];
  const channelOps = new ChannelOperations({
    registry: channelRegistry,
    configs: loadChannelConfigs(),
    repo,
    run: (input, onMessagesCommitted) => {
      return (async function* () {
        const defaultModelId = resolveChannelModel();
        const execution = await agentTurns.start({
          source: {
            type: "channel",
            kind: input.channel,
            channelUserId: input.channelUserId,
            ...(defaultModelId ? { defaultModelId } : {}),
          },
          content: input.parts,
          onMessagesCommitted,
        });
        if (!execution) {
          yield { type: "error", message: "thread_deleted" };
          return;
        }
        yield* execution.events;
      })();
    },
    persistConfigs: (configs) => {
      try {
        repo.setSetting(CHANNELS_KEY, JSON.stringify(configs));
      } catch {
        /* 持久化失败不影响运行 */
      }
    },
    secretStore: channelSecretStore,
    feishuRegister: opts.feishuRegister ?? registerFeishuApp,
    wechatRegister: opts.wechatRegister ?? registerWechatAccount,
  });
  const channels = channelOps.gateway;

  const DEFAULT_EMBED_REPO = "nomic-ai/nomic-embed-text-v1.5-GGUF";
  const DEFAULT_EMBED_FILE = "nomic-embed-text-v1.5.Q4_K_M.gguf";

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

  const app = Fastify({ logger: false, bodyLimit: BODY_LIMIT_BYTES });

  const isExternalWebhook = (url: string): boolean => /^\/im\/[^/?#]+\/webhook(?:[?#]|$)/.test(url);

  // Feishu/Lark 等平台签名依赖原始 body；只为外部 webhook 缓冲一次，再交回 Fastify 正常 JSON 解析。
  app.addHook("preParsing", async (req, _reply, payload) => {
    if (!isExternalWebhook(req.url)) return payload;
    const contentLength = Number(req.headers["content-length"]);
    if (Number.isFinite(contentLength) && contentLength > BODY_LIMIT_BYTES) throw requestBodyTooLargeError();
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of payload as AsyncIterable<Buffer | string>) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > BODY_LIMIT_BYTES) throw requestBodyTooLargeError();
      chunks.push(buf);
    }
    const body = Buffer.concat(chunks);
    (req as RawBodyRequest).rawBody = body;
    const replay = Readable.from(body);
    (replay as Readable & { receivedEncodedLength?: number }).receivedEncodedLength = body.length;
    return replay;
  });

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

  // bearer 鉴权（/health、预检 OPTIONS 与外部 IM webhook 免鉴权；webhook 自身由 adapter 校验平台签名/secret）。
  app.addHook("onRequest", async (req, reply) => {
    if (req.method === "OPTIONS") return;
    if (req.url === "/health" || req.url.startsWith("/health?")) return;
    if (isExternalWebhook(req.url)) return;
    if (req.headers.authorization !== `Bearer ${token}`) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.get("/health", async () => ({ ok: true, name: "easywork-core" }));

  const routeContext: CoreHttpContext = {
    app,
    registry,
    local,
    models,
    localModelSettings,
    providers,
    sessionHost,
    skills,
    skillsDir,
    skillLifecycle,
    mcp,
    channels,
    channelOps,
    memory,
    agentMemory,
    embeddings,
    repo,
    sourceConversations,
    agentTurns,
    fetchImpl: opts.fetch ?? fetch,
    persistProviders,
    persistMcp,
  };

  // ---- 模型 / 本地运行时 / 本地网络 ----
  registerModelRoutes(routeContext, {
    ...(opts.llamaBinPath ? { llamaBinPath: opts.llamaBinPath } : {}),
    persistLocalNet: (bindHost) => {
      try {
        repo.setSetting(LOCAL_BIND_KEY, bindHost);
        repo.setSetting(LOCAL_APIKEY_KEY, local.getApiKey() ?? "");
      } catch {
        /* 持久化失败不影响运行 */
      }
    },
    persistHfMirror: (useMirror) => {
      repo.setSetting(HF_MIRROR_KEY, String(useMirror));
    },
    clearEmbedSetting: () => {
      try {
        fs.rmSync(embedSettingPath, { force: true });
      } catch {
        /* ignore */
      }
    },
  });

  // ---- 云端 provider 配置 ----
  registerProviderRoutes(routeContext);

  // ---- 外部 IM 渠道 Gateway + 收件箱 read model ----
  registerChannelRoutes(routeContext);

  // ---- Agent 运行（pi 托管会话，SSE 发 AgentEvent）----
  registerAgentRoutes(routeContext);

  // ---- MCP 服务器管理 ----
  registerMcpRoutes(routeContext);

  // ---- 全局 Skills ----
  registerSkillRoutes(routeContext);

  // ---- 会话 / 工作区 / 文件 / Git ----
  registerWorkspaceRoutes(routeContext);

  // ---- 记忆与向量召回（本地 CPU embedding）----
  registerMemoryRoutes(routeContext, {
    defaultEmbedRepo: DEFAULT_EMBED_REPO,
    defaultEmbedFile: DEFAULT_EMBED_FILE,
    downloadEmbeddingModel: (repoId, fileName) => models.download({ repoId, fileName, quant: "", sizeBytes: 0, shardCount: 1 }),
    saveEmbedSetting,
  });
  registerSkillLearningRoutes(routeContext);

  // ---- OpenAI/Anthropic 兼容端点（复用同一 registry） ----
  // 本地模型透传到 router；云端流式经 pi-ai（统一 ModelRegistry/AuthStorage）。
  registerOpenAICompat(app, registry, {
    localBaseUrl: (m) => local.baseUrlFor(m),
    localApiKey: () => local.getApiKey(),
    cloudModelIds: () => providers.modelIds(),
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
    channels,
    memory,
    agentMemory,
    embeddings,
    repo,
    sourceConversations,
    agentTurns,
    token,
    async start(startOpts = {}) {
      const host = startOpts.host ?? "127.0.0.1";
      const port = startOpts.port ?? 0;
      await app.listen({ port, host });
      const addr = app.server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      await channelOps.startAll().catch((err) => {
        console.error("[easywork] IM 渠道启动失败:", err);
      });
      // 启动后台自动启用向量记忆（不阻塞 listen）。
      void autoEnableEmbedding();
      return { port: actualPort, host };
    },
    async stop() {
      await app.close();
      channelOps.abortSetupSessions();
      stopMemWatch();
      // 停模型前先 flush 待抽取的记忆（抽取要用模型；停了就抽不成）。
      await sessionHost.flushAllExtraction().catch(() => {});
      try {
        sessionHost.disposeAll();
      } catch {
        /* ignore */
      }
      await skillLifecycle.close().catch(() => {});
      await local.stopAll().catch(() => {});
      await channelOps.stopAll().catch(() => {});
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
    },
  };
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

// 记忆清单（渐进式披露）构造在 agent/ew-extensions.ts；此处再导出供测试/外部复用。
export { buildMemoryManifest } from "../agent/ew-extensions.js";
