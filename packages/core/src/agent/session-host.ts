// R1 — 宿主骨架：把 pi-coding-agent 的 `createAgentSession`（无头嵌入）封装为 EasyWork 的 agent 内核。
// 输入/输出仍是我们自己的契约：调用方给 {threadId, modelId, text, cwd}，本模块产出我们的 SSE `AgentEvent`。
// 这是「pi 为核 + 单一输出口」的唯一边界翻译（见 plan），不是「在旧 loop 上适配」。
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  createAgentSession,
  AuthStorage,
  ModelRegistry,
  DefaultResourceLoader,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { streamSimple, completeSimple } from "@earendil-works/pi-ai";
import type { Model, Api, Context as PiContext, AssistantMessageEventStream, AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import { GLOBAL_SCOPE } from "@ew/shared";
import type { AgentEvent, MemoryProvider, ConversationRepo, ApprovalGate, ApprovalMode, SamplingParams, Tool } from "@ew/shared";
import type { McpClientManager } from "@ew/mcp";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { LocalBackend } from "../engine/local-backend.js";
import type { ProviderManager } from "../providers/manager.js";
import type { KnowledgeBaseStore } from "../rag/store.js";
import {
  buildEwCustomTools,
  memoryExtensionFactory,
  permissionExtensionFactory,
  type RunRuntime,
} from "./ew-extensions.js";
import { ExtractionScheduler } from "../memory/extraction-scheduler.js";

/** 宿主依赖（从 daemon 注入）。 */
export interface SessionHostDeps {
  local: LocalBackend;
  providers: ProviderManager;
  /** pi 全局配置目录（auth/models/session 落盘）。默认 ~/.easywork/pi-agent。 */
  agentDir?: string;
  /** R3：记忆（context 召回注入 + agent_end 抽取，并暴露 manage_memory 工具）。 */
  memory?: MemoryProvider;
  /** R3：会话历史 FTS 检索工具 session_search。 */
  repo?: ConversationRepo;
  /** R3：知识库检索工具 search_knowledge_base。 */
  kb?: KnowledgeBaseStore;
  /** R3：MCP 工具（桥成 customTools）。 */
  mcp?: McpClientManager;
  /** R5：内置工具（时间/计算器/HTTP/web_search）桥成 customTools。 */
  builtins?: Tool[];
}

/** 单轮运行输入。 */
export interface EwAgentRunInput {
  threadId: string;
  modelId: string;
  /** 本轮新用户输入（pi 在会话内自持历史，故只发增量）。 */
  text: string;
  /** 本轮新用户输入附带的图片（多模态；走视觉模型的 mmproj）。 */
  images?: ImageContent[];
  /** 工作区根目录（pi 工具的 cwd）。 */
  cwd: string;
  /** 是否工作区模式（启用 bash/edit/write + 审批；否则聊天模式收窄工具）。默认 false。 */
  workspace?: boolean;
  /** 记忆作用域：global（对话池，缺省）或 ws:<projectId>（工作区私有池）。 */
  memoryScope?: string;
  /** R4：本轮审批门（工作区模式下危险工具经此征询，发 approval-request SSE）。 */
  approval?: ApprovalGate;
  /** R4：工作区审批档位。默认 approve-each。 */
  approvalMode?: ApprovalMode;
  /** R5b：中断信号（SSE 断开 → 中止 pi 当前轮）。 */
  signal?: AbortSignal;
  /** 采样参数（透传给 provider 请求；本地额外注入 llama.cpp top_k/min_p/repeat_penalty）。 */
  sampling?: SamplingParams;
  /** 思考开关：true→/think，false→/no_think（Qwen3 约定，注入给模型，不污染持久化消息）。 */
  think?: boolean;
  /** 禁用的 Skill 名称：按名从 pi resourceLoader 的 skills 里过滤掉（改变即重建会话）。 */
  excludeSkills?: string[];
}

interface HostedSession {
  session: AgentSession;
  modelId: string;
  cwd: string;
  workspace: boolean;
  memoryScope: string;
  excludeSkillsKey: string;
  runtime: RunRuntime;
  dispose: () => void;
}


/**
 * 进程内会话宿主：每个 (threadId) 复用一个 pi `AgentSession`（保留上下文/compaction）。
 * modelId 或 cwd 变化则重建。pi `SessionManager` 按 threadId 落盘 + resume：daemon 重启 /
 * 会话重建后模型仍带上重启前上下文。注意它只承载「给模型的上下文」，UI/检索/渠道映射的
 * 真相源仍是 ConversationRepo（两者并存，非替换——后者提供 FTS5/渠道映射/项目元数据）。
 */
export class SessionHost {
  private readonly sessions = new Map<string, HostedSession>();
  private readonly agentDir: string;
  // pi 会话落盘目录：按 threadId 持久化，重启/重建时 resume → 模型跨重启恢复上下文。
  // 注意：ConversationRepo 仍是 UI/检索/映射的真相源；这里只承载「给模型的上下文」。
  private readonly sessionsDir: string;
  // R2：单一、落盘的共享 auth/registry（OAuth 与 key 跨重启持久；所有会话复用）。
  private readonly authStorage: AuthStorage;
  private readonly modelRegistry: ModelRegistry;
  private readonly registeredProviders = new Set<string>();
  // H1：按 threadId 串行化 run（pi 会话 + 全局 subscribe 不可并发复用）。
  private readonly runChain = new Map<string, Promise<void>>();
  // 被动记忆抽取调度（宿主拥有：关闭时能在停模型前 flush、删会话时丢弃不抽、压缩不触发并发）。
  private readonly extraction = new ExtractionScheduler(async (input) => {
    if (this.deps.memory) await this.deps.memory.observe(input);
  });

  constructor(private readonly deps: SessionHostDeps) {
    this.agentDir = deps.agentDir ?? path.join(os.homedir(), ".easywork", "pi-agent");
    fs.mkdirSync(this.agentDir, { recursive: true });
    this.sessionsDir = path.join(this.agentDir, "sessions");
    fs.mkdirSync(this.sessionsDir, { recursive: true });
    this.tunePiSettings();
    this.authStorage = AuthStorage.create(path.join(this.agentDir, "auth.json"));
    // llama-server 忽略 key，仅为通过 pi 的 provider key 校验。
    this.authStorage.set("local", { type: "api_key", key: "local" });
    this.modelRegistry = ModelRegistry.create(this.authStorage, path.join(this.agentDir, "models.json"));
    this.syncCloudProviders();
  }

  /**
   * 调校 pi 设置（写 agentDir/settings.json，SettingsManager 启动时读取）。
   * 关键：pi 默认 compaction.reserveTokens=16384，而本地模型 contextWindow 常为 4k/8k，
   * 导致 shouldCompact = tokens > contextWindow-16384 恒为真 → 每轮都触发压缩（一次 LLM 摘要），
   * 表现为输出结束后还卡几秒。下调到合理值，仅在接近真实上限时才压缩；overflow 兜底仍在。
   */
  private tunePiSettings(): void {
    const file = path.join(this.agentDir, "settings.json");
    try {
      const cur = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>) : {};
      const comp = (cur.compaction as Record<string, unknown> | undefined) ?? {};
      if (comp.reserveTokens == null) {
        cur.compaction = { ...comp, reserveTokens: 2048 };
        fs.writeFileSync(file, JSON.stringify(cur, null, 2), "utf8");
      }
    } catch {
      /* 设置写入失败不影响运行 */
    }
  }

  /**
   * 把 EasyWork 云端 provider 同步进 pi（AuthStorage key + ModelRegistry provider/headers）。
   * 幂等 + 全量对账：已删除的 provider 会被注销。provider 增删后调用。
   */
  syncCloudProviders(): void {
    const present = new Set<string>();
    for (const cfg of this.deps.providers.dump()) {
      present.add(cfg.id);
      if (cfg.apiKey) this.authStorage.set(cfg.id, { type: "api_key", key: cfg.apiKey });
      this.modelRegistry.registerProvider(cfg.id, {
        baseUrl: cfg.baseUrl,
        ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
        ...(cfg.headers ? { headers: cfg.headers } : {}),
        api: "openai-completions",
        authHeader: true,
        models: cfg.models.map((id) => ({
          id,
          name: id,
          reasoning: false,
          // 允许图片输入：pi 仅在用户实际附带图片时才下发；文本对话不受影响。
          // 非视觉模型若收到图片由后端引擎报错（属用户误操作），不影响纯文本路径。
          input: ["text", "image"] as ("text" | "image")[],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: cfg.contextWindow ?? 32768,
          maxTokens: 4096,
          ...(cfg.headers ? { headers: cfg.headers } : {}),
        })),
      });
      this.registeredProviders.add(cfg.id);
    }
    for (const id of [...this.registeredProviders]) {
      if (present.has(id)) continue;
      this.modelRegistry.unregisterProvider(id);
      this.authStorage.remove(id);
      this.registeredProviders.delete(id);
    }
  }

  /** 解析一个 EasyWork modelId → pi `Model`（本地 llama-server / 云端 provider）。 */
  private resolveModel(modelId: string): Model<Api> {
    const localBase = this.deps.local.baseUrlFor(modelId);
    if (localBase) {
      // llama-server 设了 --api-key 时（0.0.0.0 暴露），pi 调用本机也需带该 key。
      const key = this.deps.local.getApiKey?.() || "local";
      this.authStorage.set("local", { type: "api_key", key });
      const ctx = this.deps.local.contexts()[modelId];
      return {
        id: modelId,
        name: modelId,
        api: "openai-completions",
        provider: "local",
        baseUrl: localBase,
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: ctx && ctx > 0 ? ctx : 8192,
        maxTokens: 4096,
      };
    }
    const cfg = this.deps.providers.findByModel(modelId);
    if (cfg) {
      if (!this.registeredProviders.has(cfg.id)) this.syncCloudProviders();
      const m = this.modelRegistry.find(cfg.id, modelId);
      if (m) return m;
      // registry 未命中（理论不应发生）→ 手搓兜底，带上 headers，鉴权由共享 AuthStorage 提供。
      return {
        id: modelId,
        name: modelId,
        api: "openai-completions",
        provider: cfg.id,
        baseUrl: cfg.baseUrl,
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: cfg.contextWindow ?? 32768,
        maxTokens: 4096,
        ...(cfg.headers ? { headers: cfg.headers } : {}),
      };
    }
    throw new Error(`model_not_resolvable: ${modelId}`);
  }

  /**
   * Step 2：云端模型经 pi-ai 流式推理（供 /v1 网关复用同一 ModelRegistry/AuthStorage，
   * 拿到 OAuth/Anthropic 原生等统一能力）。非云端模型返回 null（由调用方回退）。
   */
  async streamCloud(
    modelId: string,
    context: PiContext,
    opts: { signal?: AbortSignal; temperature?: number; maxTokens?: number } = {},
  ): Promise<AssistantMessageEventStream | null> {
    const cfg = this.deps.providers.findByModel(modelId);
    if (!cfg) return null;
    if (!this.registeredProviders.has(cfg.id)) this.syncCloudProviders();
    const model = this.resolveModel(modelId);
    const auth = await this.modelRegistry.getApiKeyAndHeaders(model);
    return streamSimple(model, context, this.streamOpts(auth, opts));
  }

  /** 云端非流式（completeSimple）：与 streamCloud 同源，供 /v1 非流式统一走 pi。非云端返回 null。 */
  async completeCloud(
    modelId: string,
    context: PiContext,
    opts: { signal?: AbortSignal; temperature?: number; maxTokens?: number } = {},
  ): Promise<AssistantMessage | null> {
    const cfg = this.deps.providers.findByModel(modelId);
    if (!cfg) return null;
    if (!this.registeredProviders.has(cfg.id)) this.syncCloudProviders();
    const model = this.resolveModel(modelId);
    const auth = await this.modelRegistry.getApiKeyAndHeaders(model);
    return completeSimple(model, context, this.streamOpts(auth, opts));
  }

  private streamOpts(
    auth: Awaited<ReturnType<ModelRegistry["getApiKeyAndHeaders"]>>,
    opts: { signal?: AbortSignal; temperature?: number; maxTokens?: number },
  ): Record<string, unknown> {
    return {
      ...(auth.ok && auth.apiKey ? { apiKey: auth.apiKey } : {}),
      ...(auth.ok && auth.headers ? { headers: auth.headers } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
      ...(opts.maxTokens != null ? { maxTokens: opts.maxTokens } : {}),
    };
  }

  /**
   * 按 threadId 取/建持久化 SessionManager：文件存在则 open() 续接（跨重启/重建恢复
   * pi 上下文，含 compaction），否则 create() 后定向到该 threadId 文件（create 惰性写，
   * setSessionFile 指向不存在的目标只是重设路径、不产生孤儿文件）。
   */
  private sessionManagerFor(threadId: string, cwd: string): SessionManager {
    const file = path.join(this.sessionsDir, `${threadId}.jsonl`);
    if (fs.existsSync(file)) return SessionManager.open(file, this.sessionsDir, cwd);
    const sm = SessionManager.create(cwd, this.sessionsDir);
    sm.setSessionFile(file);
    return sm;
  }

  /**
   * 读该会话 pi 日志里最后一条 assistant 消息的 usage —— 打开历史会话时回填上下文用量环
   * （存档消息文本无 token 数，且不含 system/记忆/工具 schema 开销，只能从 pi 实测 usage 取）。
   * promptTokens 含缓存命中/写入（cacheRead+cacheWrite），与实时事件口径一致。
   */
  lastUsage(threadId: string): { promptTokens: number; completionTokens: number; totalTokens: number } | null {
    const file = path.join(this.sessionsDir, `${threadId}.jsonl`);
    if (!fs.existsSync(file)) return null;
    let last: { promptTokens: number; completionTokens: number; totalTokens: number } | null = null;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line) as { message?: { role?: string; usage?: PiUsage } };
        const m = o.message;
        if (m?.role === "assistant" && m.usage) {
          last = { promptTokens: promptTokensOf(m.usage), completionTokens: m.usage.output, totalTokens: m.usage.totalTokens };
        }
      } catch {
        /* 跳过坏行 */
      }
    }
    return last;
  }

  /** 取/建该 thread 的会话。modelId/cwd/workspace/scope 变化则重建。 */
  private async getOrCreate(
    threadId: string,
    modelId: string,
    cwd: string,
    workspace: boolean,
    memoryScope: string,
    excludeSkills: string[],
  ): Promise<HostedSession> {
    const excludeSkillsKey = excludeSkills.slice().sort().join(",");
    const existing = this.sessions.get(threadId);
    if (
      existing &&
      existing.modelId === modelId &&
      existing.cwd === cwd &&
      existing.workspace === workspace &&
      existing.memoryScope === memoryScope &&
      existing.excludeSkillsKey === excludeSkillsKey
    ) {
      return existing;
    }
    if (existing) {
      // 会话重建（换模型/作用域）：先用旧模型把已积累的对话抽取掉，再丢弃旧会话。
      await this.extraction.flush(threadId);
      existing.dispose();
      this.sessions.delete(threadId);
    }
    const model = this.resolveModel(modelId);
    // R4：每会话一个权限运行时（run() 前写入 mode/approval）；仅工作区模式装载权限扩展。
    const runtime: RunRuntime = { mode: "approve-each", alwaysApproved: new Set() };
    // R3：记忆扩展（清单注入系统提示词 + 批量抽取）+ R4 权限扩展（tool_call 审批）。
    const factories: ExtensionFactory[] = [];
    if (this.deps.memory) {
      factories.push(
        memoryExtensionFactory({
          memory: this.deps.memory,
          scope: memoryScope,
          runtime,
          onTurn: (conv) => this.extraction.note(threadId, memoryScope, modelId, conv),
        }),
      );
    }
    // 权限/路径限定扩展：始终装载——escapesCwd 硬隔离让 read/edit/write 都不能逃出 cwd（工作区）；
    // bash 是任意 shell 无法按路径沙箱，经审批把守。工作区模式按项目档位；对话模式由调用方传 auto-edits
    //（工作区内写放行、bash 需审批）。
    factories.push(permissionExtensionFactory(runtime, cwd));
    const excluded = new Set(excludeSkills);
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: this.agentDir,
      extensionFactories: factories,
      // 禁用的 Skill 按名过滤掉（默认无 → 不改变发现结果）。
      ...(excluded.size
        ? { skillsOverride: (base) => ({ ...base, skills: base.skills.filter((s) => !excluded.has(s.name)) }) }
        : {}),
    });
    await resourceLoader.reload();
    const customTools = await buildEwCustomTools({
      sessionId: threadId,
      cwd,
      memoryScope,
      ...(this.deps.memory ? { memory: this.deps.memory } : {}),
      ...(this.deps.repo ? { repo: this.deps.repo } : {}),
      ...(this.deps.kb ? { kb: this.deps.kb } : {}),
      ...(this.deps.mcp ? { mcp: this.deps.mcp } : {}),
      ...(this.deps.builtins ? { builtins: this.deps.builtins } : {}),
    });
    const { session } = await createAgentSession({
      model,
      thinkingLevel: "off",
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      cwd,
      agentDir: this.agentDir,
      // 按 threadId 持久化 + resume：daemon 重启 / 换模型重建后，模型仍带上重启前上下文。
      sessionManager: this.sessionManagerFor(threadId, cwd),
      resourceLoader,
      // 聊天/工作区均提供完整 pi 编码工具（read/bash/edit/write/grep/ls/find）+ EasyWork customTools；
      // 安全由权限扩展统一把守：escapesCwd 限定 fs 路径，bash 经审批（对话模式 auto-edits）。
      ...(customTools.length ? { customTools } : {}),
    });
    // 采样参数注入：pi 不在 createAgentSession 暴露采样，包装 agent.streamFn 读取 runtime.sampling
    // → temperature/maxTokens 走 StreamOptions；top_p/top_k/min_p/repeat_penalty/seed/penalties 经
    // onPayload 注入请求体（top_k/min_p/repeat_penalty 是 llama.cpp 扩展，仅本地模型注入）。
    const baseStream = session.agent.streamFn;
    session.agent.streamFn = (m, context, options) => {
      const s = runtime.sampling;
      if (!s) return baseStream(m, context, options);
      const isLocal = m.provider === "local";
      const prevOnPayload = options?.onPayload;
      return baseStream(m, context, {
        ...options,
        ...(s.temperature != null ? { temperature: s.temperature } : {}),
        ...(s.maxTokens != null ? { maxTokens: s.maxTokens } : {}),
        onPayload: async (payload, mm) => {
          const base = (prevOnPayload ? await prevOnPayload(payload, mm) : undefined) ?? payload;
          return applySampling(base as Record<string, unknown>, s, isLocal);
        },
      });
    };

    const hosted: HostedSession = {
      session,
      modelId,
      cwd,
      workspace,
      memoryScope,
      excludeSkillsKey,
      runtime,
      dispose: () => session.dispose(),
    };
    this.sessions.set(threadId, hosted);
    return hosted;
  }

  /** 跑一轮，产出我们的 `AgentEvent` 流（供 SSE 转发）。按 threadId 串行化。 */
  async *run(input: EwAgentRunInput): AsyncGenerator<AgentEvent> {
    const prev = this.runChain.get(input.threadId) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => {
      release = r;
    });
    this.runChain.set(input.threadId, prev.then(() => mine));
    await prev.catch(() => {}); // 等同 thread 上一轮收尾，避免并发复用同一 pi 会话
    try {
      yield* this.runOne(input);
    } finally {
      release();
    }
  }

  private async *runOne(input: EwAgentRunInput): AsyncGenerator<AgentEvent> {
    const workspace = input.workspace ?? false;
    const memoryScope = input.memoryScope ?? GLOBAL_SCOPE;
    const hosted = await this.getOrCreate(
      input.threadId,
      input.modelId,
      input.cwd,
      workspace,
      memoryScope,
      input.excludeSkills ?? [],
    );
    const session = hosted.session;
    // R4：写入本轮权限上下文（工作区模式下 tool_call 扩展据此审批）。
    hosted.runtime.mode = input.approvalMode ?? "approve-each";
    hosted.runtime.approval = input.approval;
    hosted.runtime.sampling = input.sampling; // 采样参数（streamFn 包装读取）
    hosted.runtime.aborted = false; // 本轮是否被用户取消（取消则跳过记忆抽取 + 回滚上下文）

    // 用户取消「不计入上下文」：快照本轮 prompt 前的会话消息，取消时回滚到此（移除本轮用户消息 + 部分助手输出）。
    const snapshot = session.agent.state.messages.slice();

    // R5b：中断透传——信号 abort → 中止 pi 当前轮，并标记 aborted。
    const onAbort = (): void => {
      hosted.runtime.aborted = true;
      void session.abort().catch(() => {});
    };
    if (input.signal) {
      if (input.signal.aborted) onAbort();
      else input.signal.addEventListener("abort", onAbort);
    }

    const queue: AgentEvent[] = [];
    let notify: (() => void) | null = null;
    let done = false;
    let failed: string | null = null;
    const wake = (): void => {
      const n = notify;
      notify = null;
      n?.();
    };
    const push = (e: AgentEvent): void => {
      queue.push(e);
      wake();
    };

    const unsub = session.subscribe((ev) => {
      try {
        for (const m of mapSessionEvent(ev)) push(m);
        if (ev.type === "agent_end") {
          done = true;
          wake();
        }
      } catch (err) {
        failed = err instanceof Error ? err.message : String(err);
        done = true;
        wake();
      }
    });

    // 思考开关（Qwen3 约定）：注入 /think 或 /no_think 给模型；不改持久化的原始用户消息。
    const directive = input.think === true ? " /think" : input.think === false ? " /no_think" : "";
    const promptText = directive ? `${input.text}${directive}` : input.text;
    const promptDone = session
      .prompt(promptText, input.images?.length ? { images: input.images } : undefined)
      .catch((err: unknown) => {
      failed = err instanceof Error ? err.message : String(err);
      done = true;
      wake();
    });

    try {
      while (true) {
        while (queue.length) yield queue.shift()!;
        if (done) break;
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
      while (queue.length) yield queue.shift()!;
      await promptDone;
      if (failed) yield { type: "error", message: failed };
    } finally {
      unsub();
      input.signal?.removeEventListener("abort", onAbort);
      // 用户取消：回滚 pi 进程内上下文到本轮之前，使取消的这一轮「不计入上下文」（不影响后续轮）。
      if (input.signal?.aborted) {
        try {
          session.agent.state.messages = snapshot;
        } catch {
          /* 回滚失败不致命：下轮仍可继续 */
        }
      }
    }
  }

  /** flush 全部会话的待抽取缓冲（daemon 关停时在停模型前调用，避免丢尾部）。 */
  async flushAllExtraction(): Promise<void> {
    await this.extraction.flushAll();
  }

  /** 释放某 thread 的会话。 */
  dispose(threadId: string): void {
    this.extraction.discard(threadId); // 删会话：丢弃待抽取缓冲，不把将删的对话抽进记忆
    const s = this.sessions.get(threadId);
    if (!s) return;
    // 彻底删除：先取 pi 会话落盘文件，dispose 后删掉，避免残留可恢复的对话上下文。
    let file: string | undefined;
    try {
      file = s.session.sessionFile;
    } catch {
      /* ignore */
    }
    s.dispose();
    this.sessions.delete(threadId);
    if (file) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* 删除会话文件失败不致命 */
      }
    }
  }

  /**
   * R5b：作废全部会话缓存，下次 run 重建（customTools 在会话创建时固定，
   * MCP 等工具集变更后需重建会话才生效）。会丢失进程内上下文。
   */
  invalidateAll(): void {
    this.disposeAll();
  }

  /** 释放全部（daemon 关停）。注意：关停前应先 await flushAllExtraction()（停模型前抽完）。 */
  disposeAll(): void {
    for (const id of [...this.sessions.keys()]) this.extraction.discard(id);
    for (const s of this.sessions.values()) s.dispose();
    this.sessions.clear();
  }
}

type PiUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number };

/** pi Usage → 完整提示词 token（含缓存命中/写入；只取 input 会在 prompt cache 活跃时严重低估上下文占用）。 */
function promptTokensOf(u: { input: number; cacheRead: number; cacheWrite: number }): number {
  return u.input + u.cacheRead + u.cacheWrite;
}

/** pi `AgentSessionEvent` → 我们的 `AgentEvent`（0..n 条）。唯一的边界翻译。 */
export function mapSessionEvent(ev: AgentSessionEvent): AgentEvent[] {
  switch (ev.type) {
    case "message_update": {
      const a = ev.assistantMessageEvent;
      if (a.type === "text_delta") return [{ type: "text", text: a.delta }];
      if (a.type === "thinking_delta") return [{ type: "reasoning", text: a.delta }];
      if (a.type === "error") return [{ type: "error", message: a.error.errorMessage ?? "inference_error" }];
      return [];
    }
    case "tool_execution_start":
      return [
        {
          type: "tool-start",
          call: { id: ev.toolCallId, name: ev.toolName, arguments: safeStringify(ev.args) },
        },
      ];
    case "tool_execution_end": {
      // toPiTool 把我们的 display 放进 pi 的 details；带回去供 UI 渲染来源/引用/HTML 工件/diff。
      const details = (ev.result as { details?: unknown } | undefined)?.details;
      return [
        {
          type: "tool-end",
          call: { id: ev.toolCallId, name: ev.toolName, arguments: "" },
          result: {
            content: toolResultContent(ev.result),
            isError: ev.isError,
            ...(details != null ? { display: details } : {}),
          },
        },
      ];
    }
    case "message_end": {
      const u = ev.message.role === "assistant" ? ev.message.usage : undefined;
      if (u) {
        return [
          {
            type: "usage",
            usage: { promptTokens: promptTokensOf(u), completionTokens: u.output, totalTokens: u.totalTokens },
          },
        ];
      }
      return [];
    }
    case "agent_end": {
      const text = lastAssistantText(ev.messages);
      return [{ type: "final", message: { role: "assistant", content: text } }];
    }
    default:
      return [];
  }
}

/** 把 EasyWork 采样参数注入 OpenAI 兼容请求体；llama.cpp 扩展（top_k/min_p/repeat_penalty）仅本地。 */
export function applySampling(body: Record<string, unknown>, s: SamplingParams, isLocal: boolean): Record<string, unknown> {
  const out = { ...body };
  if (s.temperature != null) out.temperature = s.temperature;
  if (s.topP != null) out.top_p = s.topP;
  if (s.maxTokens != null) out.max_tokens = s.maxTokens;
  if (s.seed != null) out.seed = s.seed;
  if (s.frequencyPenalty != null) out.frequency_penalty = s.frequencyPenalty;
  if (s.presencePenalty != null) out.presence_penalty = s.presencePenalty;
  if (isLocal) {
    if (s.topK != null) out.top_k = s.topK;
    if (s.minP != null) out.min_p = s.minP;
    if (s.repeatPenalty != null) out.repeat_penalty = s.repeatPenalty;
  }
  return out;
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v ?? {});
  } catch {
    return "{}";
  }
}

/** pi 工具结果（AgentToolResult: { content: (TextContent|ImageContent)[] }）→ 我们的 ToolResult.content。 */
function toolResultContent(result: unknown): string {
  const content = (result as { content?: unknown })?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p): p is { type: "text"; text: string } => !!p && (p as { type?: string }).type === "text")
      .map((p) => p.text)
      .join("");
  }
  return "";
}

/** 取最后一条 assistant 消息的纯文本。 */
function lastAssistantText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown };
    if (m?.role !== "assistant") continue;
    const c = m.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      return c
        .filter((p): p is { type: "text"; text: string } => !!p && (p as { type?: string }).type === "text")
        .map((p) => p.text)
        .join("");
    }
  }
  return "";
}
