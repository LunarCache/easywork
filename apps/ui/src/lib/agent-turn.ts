import type { AgentEvent, ChatMessage, Usage } from "@ew/shared";
import type { EasyWorkClient } from "@ew/sdk";
import {
  applyAgentEvent,
  isIncrementalAssistantEvent,
  markToolRunning,
  messageText,
  setToolStatus,
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
  approve(id: string, verdict: ApprovalVerdict): Promise<boolean>;
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
  private readonly approvalQueue: PendingApproval[] = [];
  private approvalResponseId: string | null = null;
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
    this.approvalQueue.length = 0;
    this.approvalResponseId = null;
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
    this.approvalQueue.length = 0;
    this.approvalResponseId = null;
    const messages = input.regenerate
      ? replaceLastAssistantTurn(this.state.messages, text)
      : appendUserTurn(this.state.messages, text, input.images);
    this.setState({ messages, busy: true, approval: null });
    let pendingUsage: Usage | null = null;
    let completed = false;

    try {
      await policy.beforeRun?.();
      for await (const event of this.transport.run(request, abortController.signal)) {
        if (runVersion !== this.runVersion) return true;
        if (event.type === "usage") {
          pendingUsage = event.usage;
        } else if (event.type === "approval-request") {
          const approval: PendingApproval = {
            id: event.id,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.args,
          };
          const activeApproval = this.state.approval;
          if (activeApproval) this.approvalQueue.push(approval);
          this.setState({
            approval: activeApproval ?? approval,
            messages: this.applyToAssistant((message) =>
              setToolStatus(message, event.toolCallId, "awaiting-approval"),
            ),
          });
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
          this.setState({
            approval: this.removeApprovalForTool(event.call.id),
            messages: this.applyToAssistant((message) => applyAgentEvent(message, event)),
          });
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
    this.approvalQueue.length = 0;
    this.approvalResponseId = null;
    this.setState({
      approval: null,
      messages: markLastAssistantCancelled(this.state.messages),
    });
  }

  async respondApproval(verdict: ApprovalVerdict): Promise<void> {
    const approval = this.state.approval;
    if (!approval || this.approvalResponseId === approval.id) return;
    this.approvalResponseId = approval.id;
    try {
      const accepted = await this.transport.approve(approval.id, verdict);
      if (!accepted) return;
      if (this.state.approval?.id !== approval.id) return;
      this.setState({
        approval: this.approvalQueue.shift() ?? null,
        ...(verdict === "deny"
          ? {}
          : {
              messages: this.applyToAssistant((message) =>
                markToolRunning(message, approval.toolCallId),
              ),
            }),
      });
    } catch {
      // 保持审批可见，允许用户重试；工具仍处于等待态。
    } finally {
      if (this.approvalResponseId === approval.id) this.approvalResponseId = null;
    }
  }

  dispose(): void {
    this.abortController?.abort();
    this.abortController = null;
    this.runVersion += 1;
    this.approvalQueue.length = 0;
    this.approvalResponseId = null;
    this.listeners.clear();
  }

  private applyToAssistant(update: (message: UiMsg) => UiMsg): UiMsg[] {
    return updateLastAssistant(this.state.messages, update);
  }

  private removeApprovalForTool(toolCallId: string): PendingApproval | null {
    for (let index = this.approvalQueue.length - 1; index >= 0; index -= 1) {
      if (this.approvalQueue[index]?.toolCallId === toolCallId) this.approvalQueue.splice(index, 1);
    }
    return this.state.approval?.toolCallId === toolCallId
      ? (this.approvalQueue.shift() ?? null)
      : this.state.approval;
  }

  private setState(patch: Partial<AgentTurnState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }
}
