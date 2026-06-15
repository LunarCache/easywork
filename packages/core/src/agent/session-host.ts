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
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { streamSimple, completeSimple } from "@earendil-works/pi-ai";
import type { Model, Api, Context as PiContext, AssistantMessageEventStream, AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentEvent, MemoryProvider, ConversationRepo, ApprovalGate, ApprovalMode, Tool } from "@ew/shared";
import type { McpClientManager } from "@ew/mcp";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { LocalServerManager } from "../engine/local-server-manager.js";
import type { ProviderManager } from "../providers/manager.js";
import type { KnowledgeBaseStore } from "../rag/store.js";
import {
  buildEwCustomTools,
  memoryExtensionFactory,
  permissionExtensionFactory,
  type RunRuntime,
} from "./ew-extensions.js";

/** 聊天模式收窄：排除会改文件/执行命令的 pi 自带工具。 */
const CHAT_EXCLUDED_TOOLS = ["bash", "edit", "write"];

/** 宿主依赖（从 daemon 注入）。 */
export interface SessionHostDeps {
  local: LocalServerManager;
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
  /** 工作区根目录（pi 工具的 cwd）。 */
  cwd: string;
  /** 是否工作区模式（启用 bash/edit/write + 审批；否则聊天模式收窄工具）。默认 false。 */
  workspace?: boolean;
  /** R4：本轮审批门（工作区模式下危险工具经此征询，发 approval-request SSE）。 */
  approval?: ApprovalGate;
  /** R4：工作区审批档位。默认 approve-each。 */
  approvalMode?: ApprovalMode;
  /** R5b：中断信号（SSE 断开 → 中止 pi 当前轮）。 */
  signal?: AbortSignal;
}

interface HostedSession {
  session: AgentSession;
  modelId: string;
  cwd: string;
  workspace: boolean;
  runtime: RunRuntime;
  dispose: () => void;
}

/**
 * 进程内会话宿主：每个 (threadId) 复用一个 pi `AgentSession`（保留上下文/compaction）。
 * modelId 或 cwd 变化则重建。R5 接 pi `SessionManager` 落盘做跨重启真相源。
 */
export class SessionHost {
  private readonly sessions = new Map<string, HostedSession>();
  private readonly agentDir: string;
  // R2：单一、落盘的共享 auth/registry（OAuth 与 key 跨重启持久；所有会话复用）。
  private readonly authStorage: AuthStorage;
  private readonly modelRegistry: ModelRegistry;
  private readonly registeredProviders = new Set<string>();
  // H1：按 threadId 串行化 run（pi 会话 + 全局 subscribe 不可并发复用）。
  private readonly runChain = new Map<string, Promise<void>>();

  constructor(private readonly deps: SessionHostDeps) {
    this.agentDir = deps.agentDir ?? path.join(os.homedir(), ".easywork", "pi-agent");
    fs.mkdirSync(this.agentDir, { recursive: true });
    this.authStorage = AuthStorage.create(path.join(this.agentDir, "auth.json"));
    // llama-server 忽略 key，仅为通过 pi 的 provider key 校验。
    this.authStorage.set("local", { type: "api_key", key: "local" });
    this.modelRegistry = ModelRegistry.create(this.authStorage, path.join(this.agentDir, "models.json"));
    this.syncCloudProviders();
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
          input: ["text"] as ("text" | "image")[],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32768,
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
        input: ["text"],
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
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32768,
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

  /** 取/建该 thread 的会话。modelId/cwd/workspace 变化则重建。 */
  private async getOrCreate(threadId: string, modelId: string, cwd: string, workspace: boolean): Promise<HostedSession> {
    const existing = this.sessions.get(threadId);
    if (existing && existing.modelId === modelId && existing.cwd === cwd && existing.workspace === workspace) {
      return existing;
    }
    if (existing) {
      existing.dispose();
      this.sessions.delete(threadId);
    }
    const model = this.resolveModel(modelId);
    // R4：每会话一个权限运行时（run() 前写入 mode/approval）；仅工作区模式装载权限扩展。
    const runtime: RunRuntime = { mode: "approve-each", alwaysApproved: new Set() };
    // R3：记忆扩展（context 召回 + agent_end 抽取）+ R4 权限扩展（tool_call 审批）。
    const factories: ExtensionFactory[] = [];
    if (this.deps.memory) {
      factories.push(memoryExtensionFactory({ threadId, modelId, memory: this.deps.memory, runtime }));
    }
    if (workspace) factories.push(permissionExtensionFactory(runtime, cwd));
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: this.agentDir,
      extensionFactories: factories,
    });
    await resourceLoader.reload();
    const customTools = await buildEwCustomTools({
      sessionId: threadId,
      cwd,
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
      resourceLoader,
      // R4：聊天模式收窄——排除 bash/edit/write（仅留读类 + EasyWork customTools）。
      ...(workspace ? {} : { excludeTools: CHAT_EXCLUDED_TOOLS }),
      ...(customTools.length ? { customTools } : {}),
    });
    const hosted: HostedSession = { session, modelId, cwd, workspace, runtime, dispose: () => session.dispose() };
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
    const hosted = await this.getOrCreate(input.threadId, input.modelId, input.cwd, workspace);
    const session = hosted.session;
    // R4：写入本轮权限上下文（工作区模式下 tool_call 扩展据此审批）。
    hosted.runtime.mode = input.approvalMode ?? "approve-each";
    hosted.runtime.approval = input.approval;
    hosted.runtime.recall = undefined; // M3：每轮重置召回缓存

    // R5b：中断透传——信号 abort → 中止 pi 当前轮。
    const onAbort = (): void => {
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

    const promptDone = session.prompt(input.text).catch((err: unknown) => {
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
    }
  }

  /** 释放某 thread 的会话。 */
  dispose(threadId: string): void {
    const s = this.sessions.get(threadId);
    if (s) {
      s.dispose();
      this.sessions.delete(threadId);
    }
  }

  /**
   * R5b：作废全部会话缓存，下次 run 重建（customTools 在会话创建时固定，
   * MCP 等工具集变更后需重建会话才生效）。会丢失进程内上下文。
   */
  invalidateAll(): void {
    this.disposeAll();
  }

  /** 释放全部（daemon 关停）。 */
  disposeAll(): void {
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
    case "tool_execution_end":
      return [
        {
          type: "tool-end",
          call: { id: ev.toolCallId, name: ev.toolName, arguments: "" },
          result: { content: toolResultContent(ev.result), isError: ev.isError },
        },
      ];
    case "message_end": {
      const u = ev.message.role === "assistant" ? ev.message.usage : undefined;
      if (u) {
        return [
          {
            type: "usage",
            usage: { promptTokens: u.input, completionTokens: u.output, totalTokens: u.totalTokens },
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
