// R1 — 宿主骨架：把 pi-coding-agent 的 `createAgentSession`（无头嵌入）封装为 EasyWork 的 agent 内核。
// 输入/输出仍是我们自己的契约：调用方给 {threadId, modelId, text, cwd}，本模块产出我们的 SSE `AgentEvent`。
// 这是「pi 为核 + 单一输出口」的唯一边界翻译（见 plan），不是「在旧 loop 上适配」。
import {
  createAgentSession,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import type { Context as PiContext, AssistantMessageEventStream, AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import { GLOBAL_SCOPE } from "@ew/shared";
import type { AgentEvent, MemoryProvider, ConversationRepo, ApprovalGate, ApprovalMode, SamplingParams, ThinkLevel, Tool } from "@ew/shared";
import type { McpClientManager } from "@ew/mcp";
import type { LocalBackend } from "../engine/local-backend.js";
import type { ProviderManager } from "../providers/manager.js";
import type { RunRuntime } from "./ew-extensions.js";
import { ExtractionScheduler } from "../memory/extraction-scheduler.js";
import { promptTokensOf, type AgentTokenUsage } from "./agent-usage.js";
import { AgentProviderRuntime } from "./provider-runtime.js";
import { runAgentTurn } from "./run-agent-turn.js";
import { agentSessionResourceKey, buildAgentSessionResources } from "./session-resources.js";
import { AgentSessionStore } from "./session-store.js";
import { ThreadRunQueue } from "./thread-run-queue.js";
import { diffTurnFiles, snapshotTurnFiles } from "./turn-artifacts.js";
import type { StageSkillCandidate } from "../skill-learning/candidate-tool.js";

/** 宿主依赖（从 daemon 注入）。 */
export interface SessionHostDeps {
  local: LocalBackend;
  providers: ProviderManager;
  /** pi 全局配置目录（auth/models/session 落盘）。默认 ~/.easywork/pi-agent。 */
  agentDir?: string;
  /** 额外全局 Skill 目录；与 UI 的全局 Skills 来源保持一致。 */
  globalSkillPaths?: string[];
  /** R3：记忆（context 召回注入 + agent_end 抽取，并暴露 manage_memory 工具）。 */
  memory?: MemoryProvider;
  /** R3：会话历史 FTS 检索工具 session_search。 */
  repo?: ConversationRepo;
  /** R3：MCP 工具（桥成 customTools）。 */
  mcp?: McpClientManager;
  /** R5：内置工具（时间/计算器/HTTP/explore_web）桥成 customTools。 */
  builtins?: Tool[];
  /** 本地模型默认运行设置：调用方未显式传 sampling 时使用。 */
  localModelSettings?: {
    samplingFor(modelId: string): SamplingParams | undefined;
  };
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
  /** 思考档位（off/low/medium/high）：云端经 pi setThinkingLevel；本地经 streamFn 注入 llama.cpp 思考参数。 */
  thinkingLevel?: ThinkLevel;
  /** 重试/重新生成：先把上一轮（最后一条 user + 其后助手）从 pi 会话回滚，再用本轮 text 重新生成。 */
  regenerate?: boolean;
  /** 禁用的 Skill 名称：按名从 pi resourceLoader 的 skills 里过滤掉（改变即重建会话）。 */
  excludeSkills?: string[];
  /** 禁用的 customTool 名称（改变即重建会话）。 */
  excludeTools?: string[];
  /** 普通对话是否在本轮串行边界内采集最终新增/修改工件。 */
  trackArtifacts?: boolean;
}

interface HostedSession {
  session: AgentSession;
  modelId: string;
  cwd: string;
  workspace: boolean;
  memoryScope: string;
  excludeSkillsKey: string;
  excludeToolsKey: string;
  modelRevision: number;
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
  private readonly deleting = new Set<string>();
  private stageSkillCandidate?: StageSkillCandidate;
  private readonly sessionStore: AgentSessionStore;
  private readonly agentDir: string;
  // R2：provider/runtime seam 拥有共享 auth/registry（OAuth 与 key 跨重启持久；所有会话复用）。
  private readonly providerRuntime: AgentProviderRuntime;
  // H1：按 threadId 串行化 run（pi 会话 + 全局 subscribe 不可并发复用）。
  private readonly runQueue = new ThreadRunQueue();
  // 被动记忆抽取调度（宿主拥有：关闭时能在停模型前 flush、删会话时丢弃不抽、压缩不触发并发）。
  private readonly extraction = new ExtractionScheduler(async (input) => {
    if (this.deps.memory) await this.deps.memory.observe(input);
  });

  constructor(private readonly deps: SessionHostDeps) {
    this.sessionStore = new AgentSessionStore(deps.agentDir);
    this.agentDir = this.sessionStore.agentDir;
    this.providerRuntime = new AgentProviderRuntime({
      agentDir: this.agentDir,
      local: this.deps.local,
      providers: this.deps.providers,
    });
  }

  /**
   * 把 EasyWork 云端 provider 同步进 pi（AuthStorage key + ModelRegistry provider/headers）。
   * 幂等 + 全量对账：已删除的 provider 会被注销。provider 增删后调用。
   */
  syncCloudProviders(): void {
    this.providerRuntime.syncCloudProviders();
  }

  setSkillCandidateStager(stage: StageSkillCandidate): void {
    this.stageSkillCandidate = stage;
    this.invalidateAll();
  }

  /** 解析一个 EasyWork modelId → pi `Model`（本地 llama / 云端 provider）。 */
  private resolveModel(modelId: string) {
    return this.providerRuntime.resolveModel(modelId);
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
    return this.providerRuntime.streamCloud(modelId, context, opts);
  }

  /** 云端非流式（completeSimple）：与 streamCloud 同源，供 /v1 非流式统一走 pi。非云端返回 null。 */
  async completeCloud(
    modelId: string,
    context: PiContext,
    opts: { signal?: AbortSignal; temperature?: number; maxTokens?: number } = {},
  ): Promise<AssistantMessage | null> {
    return this.providerRuntime.completeCloud(modelId, context, opts);
  }

  /**
   * 读该会话 pi 日志里最后一条 assistant 消息的 usage —— 打开历史会话时回填上下文用量环
   * （存档消息文本无 token 数，且不含 system/记忆/工具 schema 开销，只能从 pi 实测 usage 取）。
   * promptTokens 含缓存命中/写入（cacheRead+cacheWrite），与实时事件口径一致。
   */
  lastUsage(threadId: string): AgentTokenUsage | null {
    return this.sessionStore.lastUsage(threadId);
  }

  /** 取/建该 thread 的会话。modelId/cwd/workspace/scope 变化则重建。 */
  private async getOrCreate(
    threadId: string,
    modelId: string,
    cwd: string,
    workspace: boolean,
    memoryScope: string,
    excludeSkills: string[],
    excludeTools: string[],
  ): Promise<HostedSession> {
    const excludeSkillsKey = agentSessionResourceKey(excludeSkills);
    const excludeToolsKey = agentSessionResourceKey(excludeTools);
    const modelRevision = this.providerRuntime.modelRevision(modelId);
    const existing = this.sessions.get(threadId);
    if (
      existing &&
      existing.modelId === modelId &&
      existing.cwd === cwd &&
      existing.workspace === workspace &&
      existing.memoryScope === memoryScope &&
      existing.excludeSkillsKey === excludeSkillsKey &&
      existing.excludeToolsKey === excludeToolsKey &&
      existing.modelRevision === modelRevision
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
    const resources = await buildAgentSessionResources({
      agentDir: this.agentDir,
      noteMemoryTurn: (threadId, scope, modelId, conv) => this.extraction.note(threadId, scope, modelId, conv),
      ...(this.deps.globalSkillPaths?.length ? { globalSkillPaths: this.deps.globalSkillPaths } : {}),
      ...(this.deps.memory ? { memory: this.deps.memory } : {}),
      ...(this.deps.repo ? { repo: this.deps.repo } : {}),
      ...(this.deps.mcp ? { mcp: this.deps.mcp } : {}),
      ...(this.deps.builtins ? { builtins: this.deps.builtins } : {}),
      ...(this.stageSkillCandidate ? { stageSkillCandidate: this.stageSkillCandidate } : {}),
    }, {
      threadId,
      modelId,
      cwd,
      memoryScope,
      excludeSkills,
      excludeTools,
    });
    const { runtime, resourceLoader, customTools } = resources;
    const { session } = await createAgentSession({
      model,
      authStorage: this.providerRuntime.authStorage,
      modelRegistry: this.providerRuntime.modelRegistry,
      cwd,
      agentDir: this.agentDir,
      // 按 threadId 持久化 + resume：daemon 重启 / 换模型重建后，模型仍带上重启前上下文。
      sessionManager: this.sessionStore.sessionManagerFor(threadId, cwd),
      resourceLoader,
      // 聊天/工作区均提供完整 pi 编码工具（read/bash/edit/write/grep/ls/find）+ EasyWork customTools；
      // 安全由权限扩展统一把守：escapesCwd 限定 fs 路径，bash 经审批（对话模式 auto-edits）。
      ...(customTools.length ? { customTools } : {}),
    });
    // 自动重试默认开：provider 抖动/限流时 pi 自带退避重试（事件经 mapSessionEvent 提示 UI）。
    session.setAutoRetryEnabled(true);
    // streamFn 包装（pi 不在 createAgentSession 暴露采样/缓存/本地思考，统一在此注入）：
    // - 采样：temperature/maxTokens 走 StreamOptions；其余经 onPayload 注入请求体（local 扩展字段）。
    // - 本地思考：local 经 onPayload 注入 chat_template_kwargs.enable_thinking + thinking_budget_tokens。
    // - prompt caching：仅 Anthropic-shaped API 开 cacheRetention=long + sessionId（会话级缓存）。
    const baseStream = session.agent.streamFn;
    session.agent.streamFn = (m, context, options) => {
      const isLocal = m.provider === "local";
      const s = runtime.sampling;
      const level = runtime.thinkingLevel ?? "off";
      const prevOnPayload = options?.onPayload;
      // cacheRetention/sessionId 是 Anthropic prompt-caching 语义；对 OpenAI 兼容 provider（DeepSeek 等）
      // 强加会触发缓存式 websocket 传输或非法字段，导致**空输出**。OpenAI 系本就服务端自动缓存，无需该参数。
      const supportsCaching = m.api === "anthropic-messages";
      return baseStream(m, context, {
        ...options,
        ...(s?.temperature != null ? { temperature: s.temperature } : {}),
        ...(s?.maxTokens != null ? { maxTokens: s.maxTokens } : {}),
        ...(supportsCaching ? { cacheRetention: "long" as const, sessionId: threadId } : {}),
        onPayload: async (payload, mm) => {
          let body = ((prevOnPayload ? await prevOnPayload(payload, mm) : undefined) ?? payload) as Record<
            string,
            unknown
          >;
          if (s) body = applySampling(body, s, isLocal);
          body = isLocal ? injectLocalThinking(body, level) : injectCloudThinking(body, level);
          return body;
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
      excludeToolsKey,
      modelRevision,
      runtime,
      dispose: () => session.dispose(),
    };
    this.sessions.set(threadId, hosted);
    return hosted;
  }

  /** 跑一轮，产出我们的 `AgentEvent` 流（供 SSE 转发）。按 threadId 串行化。 */
  async *run(input: EwAgentRunInput): AsyncGenerator<AgentEvent> {
    const release = await this.runQueue.acquire(input.threadId);
    try {
      if (this.deleting.has(input.threadId)) throw new Error("thread_deleted");
      const turnFilesBefore = input.trackArtifacts ? snapshotTurnFiles(input.cwd) : null;
      let sawFinal = false;
      for await (const event of this.runOne(input)) {
        if (event.type === "final") sawFinal = true;
        yield event;
      }
      if (turnFilesBefore && sawFinal && !input.signal?.aborted) {
        const artifacts = diffTurnFiles(turnFilesBefore, snapshotTurnFiles(input.cwd));
        if (artifacts.length > 0) yield { type: "artifacts", artifacts };
      }
    } finally {
      release();
    }
  }

  /** HTTP 等入口在创建持久化 thread 前调用，拒绝已完成删除的迟到请求。 */
  isThreadDeleted(threadId: string): boolean {
    return this.deleting.has(threadId);
  }

  /** 把 HTTP 历史落库也纳入 thread 屏障；删除先到时拒绝迟到提交。 */
  async commitThread(threadId: string, commit: () => Promise<void> | void): Promise<boolean> {
    const release = await this.runQueue.acquire(threadId);
    try {
      if (this.deleting.has(threadId)) return false;
      await commit();
      return true;
    } finally {
      release();
    }
  }

  /**
   * 手动压缩该 thread 的上下文（pi `session.compact()`）。排进同一 runChain 串行——
   * 不能与 run 并发动同一 AgentSession。无活动会话（未建/未跑过）则跳过。
   */
  async compact(threadId: string): Promise<{ tokensBefore?: number; tokensAfter?: number; skipped?: boolean }> {
    const release = await this.runQueue.acquire(threadId);
    try {
      // 必须在屏障之后再读 session：在途的换模型 run 会 dispose 旧会话并建新会话；
      // 在创建中的首轮 run 也要等它建好。提前读会拿到将被弃用/尚不存在的会话。
      const hosted = this.sessions.get(threadId);
      if (!hosted) return { skipped: true };
      // 清掉上一轮残留的采样/思考档位，避免压缩总结的 LLM 调用继承小 maxTokens 等而产出残缺总结。
      hosted.runtime.sampling = undefined;
      hosted.runtime.thinkingLevel = "off";
      const r = await hosted.session.compact();
      return {
        ...(r.tokensBefore != null ? { tokensBefore: r.tokensBefore } : {}),
        ...(r.estimatedTokensAfter != null ? { tokensAfter: r.estimatedTokensAfter } : {}),
      };
    } finally {
      release();
    }
  }

  /**
   * 把会话上一轮回滚（重新生成用）：定位最后一条 user 消息条目，导航到其父节点 →
   * 之后 prompt 会从那里另起分支，旧 user+助手成为兄弟分支、不再进上下文（含 JSONL/resume 正确）。
   * 主路用 pi `navigateTree`；失败兜底为内存截断（仅当轮正确，与 abort 回滚同机制）。
   */
  private async rollbackLastUserTurn(session: HostedSession["session"]): Promise<void> {
    try {
      const branch = session.sessionManager.getBranch();
      let lastUser: { id: string; parentId: string | null } | undefined;
      for (const e of branch) {
        const m = (e as { type?: string; message?: { role?: string } }).message;
        if ((e as { type?: string }).type === "message" && m?.role === "user")
          lastUser = e as { id: string; parentId: string | null };
      }
      if (lastUser?.parentId) {
        await session.navigateTree(lastUser.parentId);
        return;
      }
    } catch {
      /* 落到内存兜底 */
    }
    try {
      const msgs = session.agent.state.messages as Array<{ role?: string }>;
      let cut = -1;
      for (let i = msgs.length - 1; i >= 0; i--)
        if (msgs[i]?.role === "user") {
          cut = i;
          break;
        }
      if (cut >= 0) session.agent.state.messages = msgs.slice(0, cut) as typeof session.agent.state.messages;
    } catch {
      /* 回滚失败不致命：退化为续问 */
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
      input.excludeTools ?? [],
    );
    const session = hosted.session;
    const isLocal = this.providerRuntime.isLocalModel(input.modelId);
    const sampling = input.sampling ?? (isLocal ? this.deps.localModelSettings?.samplingFor(input.modelId) : undefined);
    // R4：写入本轮权限上下文（工作区模式下 tool_call 扩展据此审批）。
    hosted.runtime.mode = input.approvalMode ?? "approve-each";
    hosted.runtime.approval = input.approval;
    hosted.runtime.sampling = sampling; // 采样参数（streamFn 包装读取）
    hosted.runtime.thinkingLevel = input.thinkingLevel ?? "off"; // 思考档位（本地 streamFn 注入读取）
    hosted.runtime.aborted = false; // 本轮是否被用户取消（取消则跳过记忆抽取 + 回滚上下文）
    // 云端真分级思考：pi setThinkingLevel 驱动 thinkingBudgets（自动 clamp 到模型能力；本地 reasoning=false
    // 会被 clamp 到 off，实际由 streamFn 的 injectLocalThinking 注入 llama.cpp 思考参数生效）。幂等：仅变化才存盘。
    session.setThinkingLevel(hosted.runtime.thinkingLevel);

    // 重新生成：先把上一轮（最后一条 user + 其后助手）从 pi 会话回滚，再重发同一 text → 全新作答，
    // 且模型不会看到上一版答案（上下文正确）。须在 snapshot 之前做。
    if (input.regenerate) await this.rollbackLastUserTurn(session);

    // 思考：云端经 setThinkingLevel，本地经 streamFn 注入 payload（enable_thinking/thinking_budget_tokens）。
    // 本地额外补 /think·/no_think 文本兜底——若 llama.cpp 构建不认 payload 字段，文本指令仍能可靠开/关
    // （Qwen3 约定；与 payload 同向不冲突）。云端不注入文本。
    const directive = isLocal ? (hosted.runtime.thinkingLevel === "off" ? " /no_think" : " /think") : "";
    const promptText = directive ? `${input.text}${directive}` : input.text;
    yield* runAgentTurn({
      session,
      text: promptText,
      ...(input.images?.length ? { images: input.images } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      mapEvent: mapSessionEvent,
      onAbort: () => {
        hosted.runtime.aborted = true;
      },
      onDiscard: () => {
        hosted.runtime.aborted = true;
      },
    });
  }

  /** flush 全部会话的待抽取缓冲（daemon 关停时在停模型前调用，避免丢尾部）。 */
  async flushAllExtraction(): Promise<void> {
    await this.extraction.flushAll();
  }

  /**
   * 在该 thread 的 run 串行屏障内删除：先等活动轮次结束，再丢弃/等待抽取，最后执行持久层删除。
   * 成功后保留 tombstone，阻止已排队或迟到的请求重新创建同 id 会话；失败则恢复可用状态。
   */
  async deleteThread(threadId: string, deletePersistentState: () => Promise<void> | void): Promise<void> {
    this.deleting.add(threadId);
    const release = await this.runQueue.acquire(threadId);
    let persistentDeleted = false;
    try {
      await this.extraction.discard(threadId);
      await deletePersistentState();
      persistentDeleted = true;
      this.disposeSession(threadId, true);
    } catch (error) {
      // 持久层尚未删除时恢复 thread；若已删而 pi 文件清理失败，保留 tombstone 防止复活并允许重试 DELETE。
      if (!persistentDeleted) this.deleting.delete(threadId);
      throw error;
    } finally {
      release();
    }
  }

  /** 释放某 thread 的会话。 */
  dispose(threadId: string): void {
    void this.extraction.discard(threadId); // 非删除重建：异步丢弃待抽取缓冲
    this.disposeSession(threadId);
  }

  private disposeSession(threadId: string, strict = false): void {
    const s = this.sessions.get(threadId);
    if (!s) {
      if (strict) this.sessionStore.deleteThreadSessionFile(threadId);
      return;
    }
    // 彻底删除：先取 pi 会话落盘文件，dispose 后删掉，避免残留可恢复的对话上下文。
    let file: string | undefined;
    try {
      file = s.session.sessionFile;
    } catch {
      /* ignore */
    }
    s.dispose();
    this.sessions.delete(threadId);
    if (strict) {
      this.sessionStore.deleteSessionFileStrict(file);
      this.sessionStore.deleteThreadSessionFile(threadId);
    } else {
      this.sessionStore.deleteSessionFile(file);
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
    for (const id of [...this.sessions.keys()]) void this.extraction.discard(id);
    for (const s of this.sessions.values()) s.dispose();
    this.sessions.clear();
  }
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
      if (ev.willRetry) return []; // 重试/压缩续写在即，别发提前的 final
      // 末条 assistant 以 error 收尾（如 provider 400/tool schema 拒绝）→ 冒泡为 error 事件，
      // 否则会被吞成空 final、用户「没有输出」却看不到原因。仅在真正终止（!willRetry）时冒泡。
      const msgs = ev.messages as Array<{ role?: string; stopReason?: string; errorMessage?: string }>;
      const lastAsst = [...msgs].reverse().find((m) => m.role === "assistant");
      if (lastAsst?.stopReason === "error") {
        return [{ type: "error", message: lastAsst.errorMessage ?? "inference_error" }];
      }
      const text = lastAssistantText(ev.messages);
      return [{ type: "final", message: { role: "assistant", content: text } }];
    }
    case "auto_retry_start":
      return [
        {
          type: "retry",
          attempt: ev.attempt,
          maxAttempts: ev.maxAttempts,
          ...(ev.delayMs != null ? { delayMs: ev.delayMs } : {}),
          ...(ev.errorMessage ? { message: ev.errorMessage } : {}),
        },
      ];
    case "compaction_start":
      return [{ type: "compaction", phase: "start", reason: ev.reason }];
    case "compaction_end":
      return [
        {
          type: "compaction",
          phase: "end",
          reason: ev.reason,
          // ok=false：中止或无结果（失败）—— UI 据此区分「已压缩」与「压缩未完成」，不谎报成功。
          ok: !ev.aborted && ev.result != null,
          ...(ev.result?.tokensBefore != null ? { tokensBefore: ev.result.tokensBefore } : {}),
          ...(ev.result?.estimatedTokensAfter != null ? { tokensAfter: ev.result.estimatedTokensAfter } : {}),
        },
      ];
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

/** 思考档位 → 本地思考预算（token）。off=0 关思考；其余分级。常量可按模型/经验调。 */
const THINK_BUDGET: Record<ThinkLevel, number> = { off: 0, low: 1024, medium: 4096, high: 16384 };

/**
 * 本地（llama.cpp / llama.app）思考注入：往 /v1/chat/completions 请求体写思考开关 + 预算。
 * - chat_template_kwargs.enable_thinking：开/关思考（Qwen3 等混合模型识别）。
 * - thinking_budget_tokens：思考预算（顶层字段，仅在 router 未设 --reasoning-budget 时生效，我们未设）。
 * 字段名/语义随 llama.cpp 版本有别，需真机校准；不被接受时模型回退默认行为，不报错。
 */
export function injectLocalThinking(body: Record<string, unknown>, level: ThinkLevel): Record<string, unknown> {
  const on = level !== "off";
  const prevKwargs = (body.chat_template_kwargs as Record<string, unknown> | undefined) ?? {};
  return {
    ...body,
    chat_template_kwargs: { ...prevKwargs, enable_thinking: on },
    thinking_budget_tokens: THINK_BUDGET[level],
  };
}

/**
 * 云端混合推理模型（DeepSeek-V4 等 OpenAI 兼容端）思考注入：
 * - `thinking: { type: "enabled"|"disabled" }`：思考开关（off → 真正关闭，省 reasoning token）。
 * - `reasoning_effort: low|medium|high`：思考强度（provider 内部映射，如 low/medium→high）。
 * 这些字段是该类 provider 的扩展（经请求体顶层透传，等价其 OpenAI SDK 的 extra_body）；
 * 不支持的 provider 会忽略或拒绝——故仅在 streamFn 里对云端注入，且保留 off 时不外发 reasoning 的兜底。
 */
export function injectCloudThinking(body: Record<string, unknown>, level: ThinkLevel): Record<string, unknown> {
  if (level === "off") return { ...body, thinking: { type: "disabled" } };
  return { ...body, thinking: { type: "enabled" }, reasoning_effort: level };
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
