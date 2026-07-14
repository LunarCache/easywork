import fs from "node:fs";
import { workspaceScope } from "@ew/shared";
import { chatWorkspaceDir } from "../config/paths.js";
import type { SessionHost } from "../agent/session-host.js";
import type { LocalMemoryProvider } from "@ew/memory";
import type { SkillCandidateService } from "../skill-learning/candidate-service.js";
import type { SqliteConversationRepo } from "../store/conversation.js";

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

export interface SourceConversationLifecycle {
  claimRun(input: SourceConversationRunInput): Promise<ClaimedSourceConversationRun | null>;
  delete(threadId: string): Promise<SourceConversationDeleteResult>;
  discardEmpty(threadId: string, claim: SourceConversationRunClaim): Promise<void>;
  deleteProject(projectId: string): Promise<void>;
}

/** Owns source-provenance cleanup behind the same barrier as the Agent runtime. */
class DefaultSourceConversationLifecycle implements SourceConversationLifecycle {
  private readonly projectDeletions = new Map<string, Promise<void>>();

  constructor(
    private readonly sessionHost: SessionHost,
    private readonly memory: LocalMemoryProvider,
    private readonly skillCandidates: SkillCandidateService,
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

  async delete(threadId: string): Promise<SourceConversationDeleteResult> {
    const projectId = this.repo.getThread(threadId)?.projectId;
    let factsRemoved = 0;
    await this.sessionHost.deleteThread(threadId, async () => {
      factsRemoved = await this.removeOwnedState(threadId);
    });

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
    this.skillCandidates.deleteWorkspace(projectId);
    this.repo.deleteProject(projectId);
  }

  private async removeOwnedState(threadId: string): Promise<number> {
    const factsRemoved = await this.memory.deleteBySession(threadId);
    this.skillCandidates.removeSource(threadId);
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

export function createSourceConversationLifecycle(
  sessionHost: SessionHost,
  memory: LocalMemoryProvider,
  skillCandidates: SkillCandidateService,
  repo: SqliteConversationRepo,
): SourceConversationLifecycle {
  return new DefaultSourceConversationLifecycle(sessionHost, memory, skillCandidates, repo);
}
