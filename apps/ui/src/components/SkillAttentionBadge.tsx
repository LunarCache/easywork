import type { SkillCandidate, SkillLearningStatus } from "@ew/shared";

export interface SkillAttention {
  pending: number;
  error: boolean;
}

export function deriveSkillAttention(candidates: SkillCandidate[], status: SkillLearningStatus): SkillAttention {
  return {
    pending: candidates.filter((candidate) => candidate.status === "pending" && candidate.createdBy === "background-learning").length,
    error: status.lastResult === "error",
  };
}

export function SkillAttentionBadge({
  attention,
  testId,
}: {
  attention?: SkillAttention;
  testId?: string;
}) {
  if (!attention || (!attention.pending && !attention.error)) return null;
  const label = attention.error ? (attention.pending ? `${attention.pending}!` : "!") : String(attention.pending);
  const title = [
    attention.pending ? `${attention.pending} 个后台 Skill 候选待审核` : "",
    attention.error ? "自动 Skill 学习上次检查失败" : "",
  ].filter(Boolean).join("；");
  return (
    <span
      className={`skill-attention-badge ${attention.error ? "error" : ""}`}
      data-testid={testId}
      title={title}
    >
      {label}
    </span>
  );
}
