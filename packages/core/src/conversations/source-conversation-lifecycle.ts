import fs from "node:fs";
import { workspaceScope, type ChannelKind, type Thread } from "@ew/shared";
import { chatWorkspaceDir } from "../config/paths.js";
import type { SessionHost } from "../agent/session-host.js";
import type { LocalMemoryProvider } from "@ew/memory";
import type { SkillCandidateLifecycle } from "../skill-learning/candidate-service.js";
import type { SqliteConversationRepo } from "../store/conversation.js";
import { ThreadRunQueue } from "../agent/thread-run-queue.js";

export interface SourceConversationDeleteResult {
  factsRemoved: number;
}

export interface SourceConversationRunClaim {
  generation: number;
  attempt: number;
}

export interface SourceConversationRunInput {
  threadId: string;
  modelId: string;
  title: string;
  projectId?: string;
  runWorkspaceDir: string;
}

export interface ClaimedSourceConversationRun extends SourceConversationRunClaim {
  created: boolean;
}

export interface ChannelSourceConversationRunInput {
  kind: ChannelKind;
  channelUserId: string;
  defaultModelId?: string;
}

export interface ClaimedChannelSourceConversationRun extends ClaimedSourceConversationRun {
  thread: Thread;
}

export interface SourceConversationLifecycle {
  claimRun(input: SourceConversationRunInput): Promise<ClaimedSourceConversationRun | null>;
  claimChannelRun(
    input: ChannelSourceConversationRunInput,
    accept: (thread: Thread) => void,
  ): Promise<ClaimedChannelSourceConversationRun | null>;
  delete(threadId: string): Promise<SourceConversationDeleteResult>;
  discardEmpty(threadId: string, claim: SourceConversationRunClaim): Promise<void>;
  deleteProject(projectId: string): Promise<void>;
}

/** Owns source-provenance cleanup behind the same barrier as the Agent runtime. */
class DefaultSourceConversationLifecycle implements SourceConversationLifecycle {
  private readonly projectDeletions = new Map<string, Promise<void>>();
  private readonly channelDeletions = new Set<string>();
  private readonly channelClaims = new ThreadRunQueue();

  constructor(
    private readonly sessionHost: SessionHost,
    private readonly memory: LocalMemoryProvider,
    private readonly skillLifecycle: Pick<SkillCandidateLifecycle, "deleteWorkspace" | "removeSource">,
    private readonly repo: SqliteConversationRepo,
  ) {}

  async claimRun(input: SourceConversationRunInput): Promise<ClaimedSourceConversationRun | null> {
    let created = false;
    const claim = await this.sessionHost.claimThreadRun(input.threadId, () => {
      if (input.projectId && (this.projectDeletions.has(input.projectId) || !this.repo.getProject(input.projectId))) {
        return false;
      }
      try {
        fs.mkdirSync(input.runWorkspaceDir, { recursive: true });
      } catch {
        // Preserve existing behavior: the first workspace tool reports an unusable cwd.
      }
      if (!this.repo.getThread(input.threadId)) {
        this.repo.createThread({
          id: input.threadId,
          modelId: input.modelId,
          title: input.title,
          ...(input.projectId ? { projectId: input.projectId } : {}),
        });
        created = true;
      }
      return true;
    });
    return claim ? { ...claim, created } : null;
  }

  async claimChannelRun(
    input: ChannelSourceConversationRunInput,
    accept: (thread: Thread) => void,
  ): Promise<ClaimedChannelSourceConversationRun | null> {
    const key = channelKey(input.kind, input.channelUserId);
    if (this.channelDeletions.has(key)) return null;
    const release = await this.channelClaims.acquire(key);
    try {
      if (this.channelDeletions.has(key)) return null;
      const existing = this.repo.findThreadForChannel(input.kind, input.channelUserId);
      const threadId = existing?.id ?? crypto.randomUUID();
      let thread = existing;
      let created = false;
      const claim = await this.sessionHost.claimThreadRun(threadId, () => {
        if (this.channelDeletions.has(key)) return false;
        if (!thread) {
          const current = this.repo.findThreadForChannel(input.kind, input.channelUserId);
          if (current) {
            thread = current;
            return false;
          }
          const runWorkspaceDir = chatWorkspaceDir(threadId);
          try {
            fs.mkdirSync(runWorkspaceDir, { recursive: true });
          } catch {
            // The first workspace tool reports an unusable cwd.
          }
          thread = this.repo.createThread({
            id: threadId,
            title: `${input.kind}:${input.channelUserId}`,
            channel: { kind: input.kind, channelId: input.channelUserId },
            ...(input.defaultModelId ? { modelId: input.defaultModelId } : {}),
          });
          this.repo.bindThreadToChannel(input.kind, input.channelUserId, threadId);
          created = true;
        }
        accept(thread);
        return true;
      });
      return claim && thread ? { ...claim, created, thread } : null;
    } finally {
      release();
    }
  }

  async delete(threadId: string): Promise<SourceConversationDeleteResult> {
    const source = this.repo.getThread(threadId);
    const projectId = source?.projectId;
    const key = source?.channel ? channelKey(source.channel.kind, source.channel.channelId) : undefined;
    if (key) this.channelDeletions.add(key);
    const releaseChannel = key ? await this.channelClaims.acquire(key) : undefined;
    let factsRemoved = 0;
    try {
      await this.sessionHost.deleteThread(threadId, async () => {
        factsRemoved = await this.removeOwnedState(threadId);
      });
    } finally {
      releaseChannel?.();
      if (key) this.channelDeletions.delete(key);
    }

    if (!projectId) this.removeScratchArtifacts(threadId);
    return { factsRemoved };
  }

  async discardEmpty(threadId: string, claim: SourceConversationRunClaim): Promise<void> {
    const discarded = await this.sessionHost.discardEmptyThread(threadId, claim.attempt, {
      isEmpty: () => this.repo.history(threadId).length === 0,
      deletePersistentState: async () => {
        await this.removeOwnedState(threadId);
      },
    });
    if (discarded) this.removeScratchArtifacts(threadId);
  }

  deleteProject(projectId: string): Promise<void> {
    const existing = this.projectDeletions.get(projectId);
    if (existing) return existing;
    const tracked = this.performProjectDeletion(projectId).catch((error) => {
      this.projectDeletions.delete(projectId);
      throw error;
    });
    this.projectDeletions.set(projectId, tracked);
    return tracked;
  }

  private async performProjectDeletion(projectId: string): Promise<void> {
    for (const thread of this.repo.listThreads({ projectId })) {
      await this.delete(thread.id);
    }
    await this.memory.deleteByScope(workspaceScope(projectId));
    this.skillLifecycle.deleteWorkspace(projectId);
    this.repo.deleteProject(projectId);
  }

  private async removeOwnedState(threadId: string): Promise<number> {
    const factsRemoved = await this.memory.deleteBySession(threadId);
    this.skillLifecycle.removeSource(threadId);
    this.repo.deleteThread(threadId);
    return factsRemoved;
  }

  private removeScratchArtifacts(threadId: string): void {
    try {
      fs.rmSync(chatWorkspaceDir(threadId), { recursive: true, force: true });
    } catch {
      // Scratch artifacts are derived convenience files; ownership cleanup already succeeded.
    }
  }
}

function channelKey(kind: ChannelKind, channelUserId: string): string {
  return `${kind}:${channelUserId}`;
}

export function createSourceConversationLifecycle(
  sessionHost: SessionHost,
  memory: LocalMemoryProvider,
  skillLifecycle: Pick<SkillCandidateLifecycle, "deleteWorkspace" | "removeSource">,
  repo: SqliteConversationRepo,
): SourceConversationLifecycle {
  return new DefaultSourceConversationLifecycle(sessionHost, memory, skillLifecycle, repo);
}
