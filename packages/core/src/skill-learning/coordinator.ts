import {
  SkillCandidateCreateSchema,
  SkillLearningSettingsSchema,
  type LearnedSkill,
  type SkillCandidate,
  type SkillCandidateCreate,
  type SkillLearningSettings,
  type SkillLearningStatus,
} from "@ew/shared";
import type { SkillManager } from "@ew/skills";

export interface SkillTrajectorySnapshot {
  threadId: string;
  memoryScope: string;
  model: string;
  userText: string;
  finalText: string;
  toolCalls: { name: string; ok: boolean }[];
  cancelled?: boolean;
  corrected?: boolean;
  recovered?: boolean;
  usedLearnedSkillIds?: string[];
}

export interface RestrictedSkillReviewInput {
  trajectory: Readonly<SkillTrajectorySnapshot>;
  catalog: readonly {
    id: string;
    name: string;
    description: string;
    whenToUse: string;
    baseSkillId?: string;
    baseContentHash?: string;
    skillMd?: string;
    packageFiles?: Record<string, string>;
  }[];
}

export type RestrictedSkillReviewer = (
  input: RestrictedSkillReviewInput,
  model: string,
) => Promise<SkillCandidateCreate | null>;

export interface SkillCandidateReviewPort {
  stage(input: SkillCandidateCreate): SkillCandidate;
  reviewContextForSkill(skillPath: string, includePackage?: boolean): {
    id: string;
    contentHash: string;
    skillMd?: string;
    packageFiles?: Record<string, string>;
  } | null;
  listLearned(): LearnedSkill[];
}

export interface SkillLearningStatePort {
  get<T>(key: string, fallback: T): T;
  set(key: string, value: unknown): void;
}

const DEFAULT_SETTINGS: SkillLearningSettings = {
  enabled: true,
  automaticReview: true,
  minToolCalls: 4,
  consolidationEnabled: false,
};
const DEFAULT_STATUS: SkillLearningStatus = { running: false };
const SECRET_BEARING = /(?:\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*\S{6,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk|ghp|xox[baprs])-[-_a-z0-9]{8,})/i;

export class SkillLearningCoordinator {
  private readonly scheduledReviews = new Set<Promise<void>>();
  private closing = false;

  constructor(
    private readonly deps: {
      state: SkillLearningStatePort;
      candidates: SkillCandidateReviewPort;
      skills: SkillManager;
      reviewer: RestrictedSkillReviewer;
    },
  ) {}

  settings(): SkillLearningSettings {
    return SkillLearningSettingsSchema.parse(this.deps.state.get("settings", DEFAULT_SETTINGS));
  }

  updateSettings(patch: Partial<SkillLearningSettings>): SkillLearningSettings {
    const next = SkillLearningSettingsSchema.parse({ ...this.settings(), ...patch });
    this.deps.state.set("settings", next);
    return next;
  }

  status(): SkillLearningStatus {
    return this.deps.state.get("status", DEFAULT_STATUS);
  }

  shouldReview(snapshot: SkillTrajectorySnapshot): boolean {
    const settings = this.settings();
    if (!settings.enabled || snapshot.cancelled || !snapshot.finalText.trim()) return false;
    if (SECRET_BEARING.test(`${snapshot.userText}\n${snapshot.finalText}`)) return false;
    if (snapshot.toolCalls.some((call) => !call.ok) && !snapshot.recovered) return false;
    return snapshot.corrected === true || snapshot.recovered === true || snapshot.toolCalls.length >= settings.minToolCalls;
  }

  schedule(snapshot: SkillTrajectorySnapshot): void {
    if (this.closing) return;
    if (snapshot.model) this.deps.state.set("last-model", snapshot.model);
    const settings = this.settings();
    if (!settings.automaticReview || !this.shouldReview(snapshot)) {
      this.writeStatus({ running: false, lastRunAt: new Date().toISOString(), lastResult: "skipped" });
      return;
    }
    const scheduled = this.review(snapshot).then(() => {}, () => {});
    this.scheduledReviews.add(scheduled);
    void scheduled.finally(() => this.scheduledReviews.delete(scheduled));
  }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.scheduledReviews]);
  }

  async review(snapshot: SkillTrajectorySnapshot, opts: { independent?: boolean } = {}): Promise<SkillLearningStatus> {
    if (snapshot.model) this.deps.state.set("last-model", snapshot.model);
    if (!this.shouldReview(snapshot)) {
      const status: SkillLearningStatus = { running: false, lastRunAt: new Date().toISOString(), lastResult: "skipped" };
      this.writeStatus(status);
      return status;
    }
    this.writeStatus({ running: true, lastRunAt: new Date().toISOString() });
    try {
      const summaries = this.deps.skills.list().map((skill) => ({
        skill,
        learned: this.deps.candidates.reviewContextForSkill(skill.dir),
      })).sort((a, b) => Number(!!b.learned && snapshot.usedLearnedSkillIds?.includes(b.learned.id)) - Number(!!a.learned && snapshot.usedLearnedSkillIds?.includes(a.learned.id)));
      let remainingBytes = 128_000;
      let remainingMetadataBytes = 32_000;
      let packages = 0;
      const catalog: RestrictedSkillReviewInput["catalog"][number][] = [];
      for (const { skill, learned } of summaries) {
        if (catalog.length >= 100) break;
        const metadata = {
          id: skill.id.slice(0, 160),
          name: skill.frontmatter.name.slice(0, 240),
          description: skill.frontmatter.description.slice(0, 600),
          whenToUse: skill.frontmatter.whenToUse.slice(0, 600),
        };
        const metadataBytes = Buffer.byteLength(JSON.stringify(metadata));
        if (metadataBytes > remainingMetadataBytes) break;
        remainingMetadataBytes -= metadataBytes;
        const full = learned && packages < 12 ? this.deps.candidates.reviewContextForSkill(skill.dir, true) : null;
        const serialized = full ? JSON.stringify({ skillMd: full.skillMd, packageFiles: full.packageFiles }) : "";
        const include = !!full && Buffer.byteLength(serialized) <= remainingBytes;
        if (include) {
          packages++;
          remainingBytes -= Buffer.byteLength(serialized);
        }
        catalog.push({
          ...metadata,
          ...(learned ? { baseSkillId: learned.id, baseContentHash: learned.contentHash } : {}),
          ...(include && full ? { skillMd: full.skillMd, packageFiles: full.packageFiles } : {}),
        });
      }
      const model = this.settings().learnerModel ?? snapshot.model;
      const proposal = await this.deps.reviewer({
        trajectory: Object.freeze({ ...snapshot, toolCalls: snapshot.toolCalls.map((call) => ({ ...call })) }),
        catalog,
      }, model);
      if (!proposal) {
        const status: SkillLearningStatus = { running: false, lastRunAt: new Date().toISOString(), lastResult: "nothing" };
        this.writeStatus(status);
        return status;
      }
      const base = proposal.baseSkillId
        ? catalog.find((skill) => skill.baseSkillId === proposal.baseSkillId)
        : undefined;
      if (proposal.baseSkillId && !base) throw new Error("reviewer_unknown_base_skill");
      if (snapshot.usedLearnedSkillIds?.length && !base) throw new Error("reviewer_must_patch_used_skill");
      const workspaceId = snapshot.memoryScope.startsWith("ws:") ? snapshot.memoryScope.slice(3) : undefined;
      const evidenceSummary = proposal.evidence[0]?.summary ?? "Reusable procedure identified from a successful trajectory";
      const parsed = SkillCandidateCreateSchema.parse({
        ...proposal,
        createdBy: "background-learning",
        scope: workspaceId ? "workspace" : "global",
        ...(workspaceId ? { workspaceId } : { workspaceId: undefined }),
        sourceThreadIds: opts.independent ? [] : [snapshot.threadId],
        evidence: opts.independent ? [] : [{ sourceThreadId: snapshot.threadId, summary: evidenceSummary }],
        learnerModel: proposal.learnerModel ?? snapshot.model,
        ...(base?.packageFiles && !proposal.packageFiles ? { packageFiles: base.packageFiles } : {}),
        ...(base ? { baseSkillId: base.baseSkillId, baseContentHash: base.baseContentHash } : { baseSkillId: undefined, baseContentHash: undefined }),
      });
      const candidate = this.deps.candidates.stage(parsed);
      const status: SkillLearningStatus = {
        running: false,
        lastRunAt: new Date().toISOString(),
        lastResult: "candidate",
        lastCandidateId: candidate.id,
      };
      this.writeStatus(status);
      return status;
    } catch (error) {
      const status: SkillLearningStatus = {
        running: false,
        lastRunAt: new Date().toISOString(),
        lastResult: "error",
        lastError: error instanceof Error ? error.message : String(error),
      };
      this.writeStatus(status);
      return status;
    }
  }

  async consolidate(): Promise<SkillLearningStatus> {
    const settings = this.settings();
    if (!settings.enabled || !settings.consolidationEnabled) {
      const status: SkillLearningStatus = { running: false, lastRunAt: new Date().toISOString(), lastResult: "skipped" };
      this.writeStatus(status);
      return status;
    }
    const eligible = this.deps.candidates.listLearned()
      .filter((skill) => skill.state !== "archived" && !skill.pinned && skill.createdBy !== "user");
    const first = eligible[0];
    if (!first) {
      const status: SkillLearningStatus = { running: false, lastRunAt: new Date().toISOString(), lastResult: "nothing" };
      this.writeStatus(status);
      return status;
    }
    const usedLearnedSkillIds = eligible
      .filter((skill) => skill.scope === first.scope && skill.workspaceId === first.workspaceId)
      .map((skill) => skill.id);
    const model = settings.learnerModel ?? this.deps.state.get<string>("last-model", "");
    if (!model) {
      const status: SkillLearningStatus = {
        running: false,
        lastRunAt: new Date().toISOString(),
        lastResult: "error",
        lastError: "no_learner_model: run a chat first or choose a learner model",
      };
      this.writeStatus(status);
      return status;
    }
    return this.review({
      threadId: "curator",
      memoryScope: first.scope === "workspace" && first.workspaceId ? `ws:${first.workspaceId}` : "global",
      model,
      userText: "Review overlapping learned Skills and propose one version-locked consolidation patch if useful.",
      finalText: "This is an opt-in dry-run; never mutate active Skills directly.",
      toolCalls: [],
      corrected: true,
      usedLearnedSkillIds,
    }, { independent: true });
  }

  private writeStatus(status: SkillLearningStatus): void {
    this.deps.state.set("status", status);
  }
}
