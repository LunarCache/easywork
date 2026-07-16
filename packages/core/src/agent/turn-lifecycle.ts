import {
  GLOBAL_SCOPE,
  messageText,
  type ApprovalGate,
  type ApprovalMode,
  type AgentEvent,
  type ChannelKind,
  type ContentPart,
  type SamplingParams,
  type StoredMessage,
  type ThinkLevel,
  type TurnArtifact,
} from "@ew/shared";
import type { ImageContent } from "@earendil-works/pi-ai";
import { chatWorkspaceDir } from "../config/paths.js";
import type { SessionHost } from "./session-host.js";
import { ToolTurnRecorder } from "./turn-recorder.js";
import { ThreadRunQueue } from "./thread-run-queue.js";
import type { SkillTrajectorySnapshot } from "../skill-learning/coordinator.js";
import type {
  SourceConversationLifecycle,
  SourceConversationRunClaim,
} from "../conversations/source-conversation-lifecycle.js";

interface AgentTurnLifecycleDeps {
  repo: {
    appendMessage(message: StoredMessage): void;
    appendMessages(messages: StoredMessage[]): void;
    nextSeq(threadId: string): number;
  };
  sourceConversations: Pick<SourceConversationLifecycle, "claimRun" | "claimChannelRun" | "discardEmpty">;
  sessionHost: Pick<SessionHost, "isThreadDeleted" | "run" | "commitThread">;
  skillLifecycle: {
    learnedIdForToolCall(name: string, args: unknown, cwd: string): string | null | undefined;
    recordTelemetry(id: string, outcome: "use"): void;
    schedule(input: SkillTrajectorySnapshot): void;
  };
}

export interface ChannelAgentTurnSource {
  type: "channel";
  kind: ChannelKind;
  channelUserId: string;
  defaultModelId?: string;
}

export interface ThreadAgentTurnSource {
  type: "thread";
  threadId: string;
  modelId: string;
  title: string;
  projectId?: string;
  runWorkspaceDir: string;
  workspace: boolean;
  memoryScope: string;
  approvalMode: ApprovalMode;
}

export interface AgentTurnLifecycleInput {
  source: ChannelAgentTurnSource | ThreadAgentTurnSource;
  content: ContentPart[];
  signal?: AbortSignal;
  approval?: ApprovalGate;
  sampling?: SamplingParams;
  thinkingLevel?: ThinkLevel;
  regenerate?: boolean;
  excludeSkills?: string[];
  excludeTools?: string[];
  trackArtifacts?: boolean;
  onMessagesCommitted?(phase: "submission" | "result", threadId: string): void;
}

export interface AgentTurnExecution {
  threadId: string;
  events: AsyncIterable<AgentEvent>;
}

export class AgentTurnLifecycle {
  private readonly channelTurns = new ThreadRunQueue();

  constructor(private readonly deps: AgentTurnLifecycleDeps) {}

  isThreadDeleted(threadId: string): boolean {
    return this.deps.sessionHost.isThreadDeleted(threadId);
  }

  async start(input: AgentTurnLifecycleInput): Promise<AgentTurnExecution | null> {
    const acceptedAt = new Date().toISOString();
    if (input.source.type === "thread") {
      const source = input.source;
      const claim = await this.deps.sourceConversations.claimRun({
        threadId: source.threadId,
        modelId: source.modelId,
        title: source.title,
        ...(source.projectId ? { projectId: source.projectId } : {}),
        runWorkspaceDir: source.runWorkspaceDir,
      });
      if (!claim) return null;
      return {
        threadId: source.threadId,
        events: this.runClaimedTurn({
          claim,
          threadId: source.threadId,
          modelId: source.modelId,
          cwd: source.runWorkspaceDir,
          workspace: source.workspace,
          memoryScope: source.memoryScope,
          approvalMode: source.approvalMode,
          submission: "transactional",
          acceptedAt,
          input,
        }),
      };
    }

    const source = input.source;
    const reservation = this.channelTurns.acquire(channelTurnKey(source.kind, source.channelUserId));
    let claim;
    try {
      claim = await this.deps.sourceConversations.claimChannelRun(
        {
          kind: source.kind,
          channelUserId: source.channelUserId,
          ...(source.defaultModelId ? { defaultModelId: source.defaultModelId } : {}),
        },
        (thread) => {
          this.deps.repo.appendMessage({
            id: crypto.randomUUID(),
            threadId: thread.id,
            role: "user",
            seq: this.deps.repo.nextSeq(thread.id),
            parts: input.content,
            createdAt: acceptedAt,
          });
        },
      );
    } catch (error) {
      void releaseReservation(reservation);
      throw error;
    }
    if (!claim) {
      void releaseReservation(reservation);
      return null;
    }
    notifySafely(input.onMessagesCommitted, "submission", claim.thread.id);

    const modelId = claim.thread.modelId || source.defaultModelId;
    const release = await reservation;
    if (!modelId) {
      return {
        threadId: claim.thread.id,
        events: releaseAfter(singleEvent({ type: "error", message: "no_model_available" }), release),
      };
    }
    return {
      threadId: claim.thread.id,
      events: releaseAfter(this.runClaimedTurn({
          claim,
          threadId: claim.thread.id,
          modelId,
          cwd: chatWorkspaceDir(claim.thread.id),
          workspace: false,
          memoryScope: GLOBAL_SCOPE,
          approvalMode: "auto-edits",
          submission: "accepted",
          acceptedAt,
          input,
        }), release),
    };
  }

  private async *runClaimedTurn(run: {
    claim: SourceConversationRunClaim & { created: boolean };
    threadId: string;
    modelId: string;
    cwd: string;
    workspace: boolean;
    memoryScope: string;
    approvalMode: ApprovalMode;
    submission: "transactional" | "accepted";
    acceptedAt: string;
    input: AgentTurnLifecycleInput;
  }): AsyncGenerator<AgentEvent> {
    const { claim, threadId, modelId, cwd, workspace, memoryScope, approvalMode, submission, acceptedAt, input } = run;
    const recorder = new ToolTurnRecorder();
    const recorded: ReturnType<ToolTurnRecorder["push"]> = [];
    const toolCalls = new Map<string, { name: string; ok: boolean }>();
    const learnedSkillReads = new Map<string, string>();
    const usedLearnedSkills = new Set<string>();
    let sawFinal = false;
    let failed = false;
    let finalContent = "";
    let finalEvent: Extract<AgentEvent, { type: "final" }> | undefined;
    let artifacts: TurnArtifact[] = [];
    const images = imagesFromContent(input.content);
    const channelEvents: AgentEvent[] = [];
    const isChannel = input.source.type === "channel";

    try {
      for await (const event of this.deps.sessionHost.run({
        threadId,
        threadGeneration: claim.generation,
        modelId,
        text: messageText(input.content),
        ...(images.length ? { images } : {}),
        cwd,
        workspace,
        memoryScope,
        approvalMode,
        ...(input.approval ? { approval: input.approval } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.sampling ? { sampling: input.sampling } : {}),
        ...(input.thinkingLevel !== undefined ? { thinkingLevel: input.thinkingLevel } : {}),
        ...(input.regenerate ? { regenerate: true } : {}),
        ...(input.excludeSkills?.length ? { excludeSkills: input.excludeSkills } : {}),
        ...(input.excludeTools?.length ? { excludeTools: input.excludeTools } : {}),
        ...((input.trackArtifacts ?? input.source.type === "channel") ? { trackArtifacts: true } : {}),
      })) {
        if (event.type === "artifacts") {
          artifacts = event.artifacts;
          continue;
        }
        if (event.type === "error") failed = true;
        if (event.type === "tool-start") {
          toolCalls.set(event.call.id, { name: event.call.name, ok: true });
          const learnedId = this.deps.skillLifecycle.learnedIdForToolCall(
            event.call.name,
            event.call.arguments,
            cwd,
          );
          if (learnedId) learnedSkillReads.set(event.call.id, learnedId);
        }
        if (event.type === "tool-end") {
          toolCalls.set(event.call.id, { name: event.call.name, ok: !event.result.isError });
          const learnedId = learnedSkillReads.get(event.call.id);
          if (learnedId && !event.result.isError) usedLearnedSkills.add(learnedId);
        }
        recorded.push(...recorder.push(event));
        if (event.type === "final") {
          sawFinal = true;
          finalContent = messageText(event.message.content);
          finalEvent = event;
          if (isChannel) channelEvents.push(event);
          continue;
        }
        if (isChannel) {
          if (event.type === "text" || event.type === "error") channelEvents.push(event);
        } else yield event;
      }
    } catch (error) {
      failed = true;
      const event: AgentEvent = { type: "error", message: error instanceof Error ? error.message : String(error) };
      if (isChannel) channelEvents.push(event);
      else yield event;
    }

    if (!sawFinal || failed || input.signal?.aborted) {
      if (submission === "transactional" && claim.created) {
        await this.deps.sourceConversations.discardEmpty(threadId, claim);
      }
      if (isChannel) {
        const error = channelEvents.findLast((event) => event.type === "error");
        if (error) yield error;
      }
      return;
    }
    let committed = false;
    try {
      committed = await this.deps.sessionHost.commitThread(threadId, () => {
        const messages: StoredMessage[] = [];
        let seq = this.deps.repo.nextSeq(threadId);
        if (submission === "transactional") {
          messages.push({
            id: crypto.randomUUID(),
            threadId,
            role: "user",
            seq: seq++,
            parts: input.content,
            createdAt: acceptedAt,
          });
        }
        for (const message of recorded) {
          messages.push({
            id: crypto.randomUUID(),
            threadId,
            role: message.role,
            seq: seq++,
            parts: message.parts,
            ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}),
            ...(message.toolResults ? { toolResults: message.toolResults } : {}),
            createdAt: new Date().toISOString(),
          });
        }
        const finalParts = finalMessageParts(finalContent, recorder.trailingReasoning());
        if (finalParts.length || artifacts.length) {
          messages.push({
            id: crypto.randomUUID(),
            threadId,
            role: "assistant",
            seq,
            parts: finalParts,
            ...(artifacts.length ? { artifacts } : {}),
            createdAt: new Date().toISOString(),
          });
        }
        this.deps.repo.appendMessages(messages);
      });
    } catch (error) {
      yield { type: "error", message: error instanceof Error ? error.message : String(error) };
      return;
    }
    if (!committed) {
      yield { type: "error", message: "thread_deleted" };
      return;
    }

    notifySafely(input.onMessagesCommitted, "result", threadId);
    if (isChannel) {
      for (const event of channelEvents) yield event;
    } else if (finalEvent) yield finalEvent;
    if (artifacts.length) yield { type: "artifacts", artifacts };
    for (const learnedId of usedLearnedSkills) {
      try {
        this.deps.skillLifecycle.recordTelemetry(learnedId, "use");
      } catch {
        // Post-commit telemetry cannot change a completed Agent Turn outcome.
      }
    }
    const calls = [...toolCalls.values()];
    try {
      this.deps.skillLifecycle.schedule({
        threadId,
        memoryScope,
        model: modelId,
        userText: messageText(input.content),
        finalText: finalContent,
        toolCalls: calls,
        corrected: /(?:不对|修正|应该|更正|wrong|correct)/i.test(messageText(input.content)),
        recovered: calls.some((call) => !call.ok) && calls.some((call) => call.ok),
        usedLearnedSkillIds: [...usedLearnedSkills],
      });
    } catch {
      // Candidate scheduling is a post-commit side effect, never a turn rollback trigger.
    }
  }
}

async function* releaseAfter(events: AsyncIterable<AgentEvent>, release: () => void): AsyncGenerator<AgentEvent> {
  try {
    yield* events;
  } finally {
    release();
  }
}

async function releaseReservation(reservation: Promise<() => void>): Promise<void> {
  const release = await reservation;
  release();
}

async function* singleEvent(event: AgentEvent): AsyncGenerator<AgentEvent> {
  yield event;
}

function channelTurnKey(kind: ChannelKind, channelUserId: string): string {
  return `${kind}\0${channelUserId}`;
}

function notifySafely(
  observer: AgentTurnLifecycleInput["onMessagesCommitted"],
  phase: "submission" | "result",
  threadId: string,
): void {
  try {
    observer?.(phase, threadId);
  } catch {
    // Inbox invalidation is advisory and cannot alter persistence or delivery semantics.
  }
}

function imagesFromContent(content: ContentPart[]): ImageContent[] {
  return content.flatMap((part) =>
    part.type === "image" && typeof part.data === "string"
      ? [{ type: "image" as const, data: part.data, mimeType: part.mimeType }]
      : [],
  );
}

function finalMessageParts(finalContent: string, trailingReasoning: string): ContentPart[] {
  let answer = finalContent;
  let inlineThinking = "";
  if (answer.includes("<think>")) {
    answer = answer.replace(/<think>([\s\S]*?)<\/think>/g, (_match, thinking: string) => {
      inlineThinking += thinking;
      return "";
    });
  }
  const reasoning = trailingReasoning.trim() || inlineThinking.trim();
  answer = answer.trim();
  return [
    ...(reasoning ? [{ type: "reasoning" as const, text: reasoning }] : []),
    ...(answer ? [{ type: "text" as const, text: answer }] : []),
  ];
}
