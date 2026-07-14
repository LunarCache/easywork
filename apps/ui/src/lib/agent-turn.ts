import type { AgentEvent, ChatMessage, Usage } from "@ew/shared";
import type { EasyWorkClient } from "@ew/sdk";
import {
  applyAgentEvent,
  isIncrementalAssistantEvent,
  messageText,
  type PendingApproval,
  type UiImage,
  type UiMsg,
} from "./agent-stream.js";
import {
  appendUserTurn,
  findLastUser,
  finishAssistantTurn,
  markLastAssistantCancelled,
  replaceLastAssistantTurn,
  toRunHistory,
  toUserContent,
  updateLastAssistant,
} from "./message-runtime.js";

export type ApprovalVerdict = "approve" | "approve-always" | "deny";

/** The transport reuses the SDK contract while tests replace only its behavior. */
export type AgentTurnRequest = Parameters<EasyWorkClient["runAgent"]>[0];

export interface AgentTurnTransport {
  run(request: AgentTurnRequest, signal: AbortSignal): AsyncIterable<AgentEvent>;
  approve(id: string, verdict: ApprovalVerdict): Promise<void>;
}

export interface AgentTurnPolicy {
  buildRequest(history: ChatMessage[], regenerate: boolean): AgentTurnRequest | null;
  /** Workspace uses this to flush an in-flight approval-mode update before the run starts. */
  beforeRun?: () => Promise<void>;
  onToolEnd?: (event: Extract<AgentEvent, { type: "tool-end" }>) => void;
  onComplete?: () => void;
}

export interface AgentTurnState {
  messages: UiMsg[];
  busy: boolean;
  notice: string | null;
  approval: PendingApproval | null;
  usage: Usage | null;
}

export interface SendAgentTurn {
  text: string;
  images: UiImage[];
  regenerate?: boolean;
}

type Listener = (state: AgentTurnState) => void;

const EMPTY_STATE: AgentTurnState = {
  messages: [],
  busy: false,
  notice: null,
  approval: null,
  usage: null,
};

/**
 * One client-side Agent Turn lifecycle shared by Chat and Workspace.
 *
 * Views provide request/refresh policy; this module exclusively owns streaming,
 * retry/regenerate, cancellation, approvals, usage and assistant completion.
 */
export class AgentTurnController {
  private state: AgentTurnState = EMPTY_STATE;
  private policy: AgentTurnPolicy;
  private abortController: AbortController | null = null;
  private runVersion = 0;
  private readonly listeners = new Set<Listener>();

  constructor(
    private readonly transport: AgentTurnTransport,
    policy: AgentTurnPolicy,
  ) {
    this.policy = policy;
  }

  getState(): AgentTurnState {
    return this.state;
  }

  setPolicy(policy: AgentTurnPolicy): void {
    this.policy = policy;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  restore(messages: UiMsg[], usage: Usage | null = null): void {
    this.abortController?.abort();
    this.abortController = null;
    this.runVersion += 1;
    this.setState({ messages, usage, busy: false, notice: null, approval: null });
  }

  setUsage(usage: Usage | null): void {
    this.setState({ usage });
  }

  async send(input: SendAgentTurn): Promise<boolean> {
    const text = input.text.trim();
    if ((!text && input.images.length === 0) || this.state.busy) return false;

    const history = toRunHistory(this.state.messages);
    history.push({ role: "user", content: toUserContent(text, input.images) });
    const policy = this.policy;
    const request = policy.buildRequest(history, input.regenerate === true);
    if (!request) return false;

    const runVersion = ++this.runVersion;
    const abortController = new AbortController();
    this.abortController = abortController;
    const messages = input.regenerate
      ? replaceLastAssistantTurn(this.state.messages, text)
      : appendUserTurn(this.state.messages, text, input.images);
    this.setState({ messages, busy: true });
    let pendingUsage: Usage | null = null;
    let completed = false;

    try {
      await policy.beforeRun?.();
      for await (const event of this.transport.run(request, abortController.signal)) {
        if (runVersion !== this.runVersion) return true;
        if (event.type === "usage") {
          pendingUsage = event.usage;
        } else if (event.type === "approval-request") {
          this.setState({ approval: { id: event.id, toolName: event.toolName, args: event.args } });
        } else if (event.type === "retry") {
          this.setState({ notice: `重试中 (${event.attempt}/${event.maxAttempts})…` });
        } else if (event.type === "compaction") {
          this.setState({
            notice:
              event.phase === "start" ? "压缩上下文中…" : event.ok === false ? "压缩未完成" : "已压缩上下文",
          });
        } else if (isIncrementalAssistantEvent(event)) {
          this.setState({ notice: null, messages: this.applyToAssistant((message) => applyAgentEvent(message, event)) });
        } else if (event.type === "final") {
          this.setState({
            ...(pendingUsage ? { usage: pendingUsage } : {}),
            messages: this.applyToAssistant((message) =>
              message.raw ? message : { ...message, raw: messageText(event.message.content) },
            ),
          });
        } else if (event.type === "error") {
          this.setState({
            messages: this.applyToAssistant((message) => ({
              ...message,
              raw: `${message.raw}\n\n[错误] ${event.message}`,
            })),
          });
        } else if (event.type === "tool-end") {
          this.setState({ messages: this.applyToAssistant((message) => applyAgentEvent(message, event)) });
          policy.onToolEnd?.(event);
        } else {
          this.setState({ messages: this.applyToAssistant((message) => applyAgentEvent(message, event)) });
        }
      }
      if (runVersion !== this.runVersion) return true;
      completed = true;
      policy.onComplete?.();
    } catch (error) {
      if (!abortController.signal.aborted && runVersion === this.runVersion) {
        this.setState({
          messages: this.applyToAssistant((message) => ({
            ...message,
            raw: `${message.raw}\n\n[请求失败] ${error instanceof Error ? error.message : String(error)}`,
          })),
        });
      }
    } finally {
      if (runVersion === this.runVersion) {
        this.abortController = null;
        this.setState({
          messages: this.applyToAssistant((message) => finishAssistantTurn(message)),
          busy: false,
          notice: null,
        });
      }
    }
    return completed || abortController.signal.aborted;
  }

  retry(): Promise<boolean> {
    const lastUser = findLastUser(this.state.messages);
    if (!lastUser) return Promise.resolve(false);
    return this.send({ text: lastUser.raw, images: lastUser.images ?? [], regenerate: true });
  }

  editRetry(text: string): Promise<boolean> {
    if (!text.trim()) return Promise.resolve(false);
    const lastUser = findLastUser(this.state.messages);
    return this.send({ text, images: lastUser?.images ?? [], regenerate: true });
  }

  stop(): void {
    this.abortController?.abort();
    this.setState({
      approval: null,
      messages: markLastAssistantCancelled(this.state.messages),
    });
  }

  async respondApproval(verdict: ApprovalVerdict): Promise<void> {
    const approval = this.state.approval;
    if (!approval) return;
    this.setState({ approval: null });
    try {
      await this.transport.approve(approval.id, verdict);
    } catch {
      // The stream may already have ended; approval responses are best effort.
    }
  }

  dispose(): void {
    this.abortController?.abort();
    this.abortController = null;
    this.runVersion += 1;
    this.listeners.clear();
  }

  private applyToAssistant(update: (message: UiMsg) => UiMsg): UiMsg[] {
    return updateLastAssistant(this.state.messages, update);
  }

  private setState(patch: Partial<AgentTurnState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }
}
