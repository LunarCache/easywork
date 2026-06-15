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
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";
import type { AgentEvent } from "@ew/shared";
import type { LocalServerManager } from "../engine/local-server-manager.js";
import type { ProviderManager } from "../providers/manager.js";

/** 宿主依赖（从 daemon 注入）。 */
export interface SessionHostDeps {
  local: LocalServerManager;
  providers: ProviderManager;
  /** pi 全局配置目录（auth/models/session 落盘）。默认 ~/.easywork/pi-agent。 */
  agentDir?: string;
}

/** 单轮运行输入。 */
export interface EwAgentRunInput {
  threadId: string;
  modelId: string;
  /** 本轮新用户输入（pi 在会话内自持历史，故只发增量）。 */
  text: string;
  /** 工作区根目录（pi 工具的 cwd）。 */
  cwd: string;
}

interface HostedSession {
  session: AgentSession;
  modelId: string;
  cwd: string;
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

  /** 取/建该 thread 的会话。modelId/cwd 变化则重建。 */
  private async getOrCreate(threadId: string, modelId: string, cwd: string): Promise<AgentSession> {
    const existing = this.sessions.get(threadId);
    if (existing && existing.modelId === modelId && existing.cwd === cwd) return existing.session;
    if (existing) {
      existing.dispose();
      this.sessions.delete(threadId);
    }
    const model = this.resolveModel(modelId);
    const { session } = await createAgentSession({
      model,
      thinkingLevel: "off",
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      cwd,
      agentDir: this.agentDir,
      // R1：用 pi 默认编码工具（read/bash/edit/write）。记忆/MCP/知识库在 R3 以 Extension/customTools 接入。
    });
    this.sessions.set(threadId, { session, modelId, cwd, dispose: () => session.dispose() });
    return session;
  }

  /** 跑一轮，产出我们的 `AgentEvent` 流（供 SSE 转发）。 */
  async *run(input: EwAgentRunInput): AsyncGenerator<AgentEvent> {
    const session = await this.getOrCreate(input.threadId, input.modelId, input.cwd);

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
