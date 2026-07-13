import { z } from "zod";

/** SKILL.md frontmatter。description + whenToUse 驱动自动触发（渐进披露）。 */
export const SkillFrontmatterSchema = z.object({
  name: z.string(),
  description: z.string(),
  whenToUse: z.string(),
  version: z.string().optional(),
  allowedTools: z.array(z.string()).optional(),
});
export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

/** Skill 发现来源：全局来源进入管理页；project 只用于工作区运行/Slash 候选。 */
export const SkillSourceKindSchema = z.enum([
  "builtin",
  "agents",
  "custom",
  "project",
]);
export type SkillSourceKind = z.infer<typeof SkillSourceKindSchema>;

export const SkillSourceSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: SkillSourceKindSchema,
  dir: z.string(),
  primary: z.boolean().optional(),
});
export type SkillSource = z.infer<typeof SkillSourceSchema>;

/** 一个已发现的 Skill（body 懒加载）。 */
export const SkillSchema = z.object({
  id: z.string(),
  dir: z.string(),
  source: SkillSourceSchema,
  frontmatter: SkillFrontmatterSchema,
  bodyPath: z.string(),
  scripts: z.array(z.string()),
  resources: z.array(z.string()),
});
export type Skill = z.infer<typeof SkillSchema>;

export const SkillCandidateStatusSchema = z.enum(["pending", "approved", "rejected", "superseded"]);
export type SkillCandidateStatus = z.infer<typeof SkillCandidateStatusSchema>;

export const SkillCandidateScopeSchema = z.enum(["global", "workspace"]);
export type SkillCandidateScope = z.infer<typeof SkillCandidateScopeSchema>;

export const SkillCandidateCreatorSchema = z.enum(["user", "foreground-agent", "background-learning", "migration"]);
export type SkillCandidateCreator = z.infer<typeof SkillCandidateCreatorSchema>;

export const SkillEvidenceSchema = z.object({
  sourceThreadId: z.string(),
  summary: z.string().min(1),
});
export type SkillEvidence = z.infer<typeof SkillEvidenceSchema>;

export const SkillValidationFindingSchema = z.object({
  code: z.string(),
  severity: z.enum(["error", "warning"]),
  message: z.string(),
  path: z.string().optional(),
});
export type SkillValidationFinding = z.infer<typeof SkillValidationFindingSchema>;

export const SkillValidationReportSchema = z.object({
  valid: z.boolean(),
  contentHash: z.string(),
  findings: z.array(SkillValidationFindingSchema),
  checkedAt: z.string(),
});
export type SkillValidationReport = z.infer<typeof SkillValidationReportSchema>;

const SkillCandidateCreateBaseSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  triggerConditions: z.array(z.string().min(1)).min(1),
  scope: SkillCandidateScopeSchema,
  workspaceId: z.string().optional(),
  proposedSkillMd: z.string().min(1),
  packageFiles: z.record(z.string(), z.string()).optional(),
  requiredTools: z.array(z.string()),
  sourceThreadIds: z.array(z.string()),
  evidence: z.array(SkillEvidenceSchema),
  reason: z.string().min(1),
  createdBy: SkillCandidateCreatorSchema,
  learnerModel: z.string().optional(),
  baseSkillId: z.string().optional(),
  baseContentHash: z.string().optional(),
});
function validateBasePair(candidate: { baseSkillId?: string; baseContentHash?: string }, ctx: z.RefinementCtx): void {
  if (!!candidate.baseSkillId !== !!candidate.baseContentHash) {
    ctx.addIssue({ code: "custom", message: "baseSkillId and baseContentHash must be provided together", path: ["baseSkillId"] });
  }
}
export const SkillCandidateCreateSchema = SkillCandidateCreateBaseSchema.superRefine(validateBasePair);
export type SkillCandidateCreate = z.infer<typeof SkillCandidateCreateSchema>;

export const SkillCandidateSchema = SkillCandidateCreateBaseSchema.extend({
  id: z.string(),
  slug: z.string(),
  status: SkillCandidateStatusSchema,
  validation: SkillValidationReportSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  rejectionReason: z.string().optional(),
  activatedPath: z.string().optional(),
}).superRefine(validateBasePair);
export type SkillCandidate = z.infer<typeof SkillCandidateSchema>;

export const SkillLearningSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  automaticReview: z.boolean().default(true),
  minToolCalls: z.number().int().min(1).max(100).default(4),
  learnerModel: z.string().optional(),
  consolidationEnabled: z.boolean().default(false),
});
export type SkillLearningSettings = z.infer<typeof SkillLearningSettingsSchema>;

export const SkillLearningStatusSchema = z.object({
  running: z.boolean(),
  lastRunAt: z.string().optional(),
  lastResult: z.enum(["candidate", "nothing", "skipped", "error"]).optional(),
  lastError: z.string().optional(),
  lastCandidateId: z.string().optional(),
});
export type SkillLearningStatus = z.infer<typeof SkillLearningStatusSchema>;

export const LearnedSkillStateSchema = z.enum(["active", "stale", "archived"]);
export type LearnedSkillState = z.infer<typeof LearnedSkillStateSchema>;

export const LearnedSkillSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  scope: SkillCandidateScopeSchema,
  workspaceId: z.string().optional(),
  path: z.string(),
  state: LearnedSkillStateSchema,
  pinned: z.boolean(),
  createdBy: SkillCandidateCreatorSchema,
  sourceCandidateId: z.string(),
  version: z.string(),
  contentHash: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastUsedAt: z.string().optional(),
  views: z.number().int().nonnegative(),
  uses: z.number().int().nonnegative(),
  successes: z.number().int().nonnegative(),
  failures: z.number().int().nonnegative(),
  corrections: z.number().int().nonnegative(),
  patches: z.number().int().nonnegative(),
  archivedPath: z.string().optional(),
});
export type LearnedSkill = z.infer<typeof LearnedSkillSchema>;

export const SkillSnapshotSchema = z.object({
  id: z.string(),
  learnedSkillId: z.string(),
  reason: z.string(),
  packageFiles: z.record(z.string(), z.string()),
  createdAt: z.string(),
});
export type SkillSnapshot = z.infer<typeof SkillSnapshotSchema>;
