import { z } from "zod";
import { defineTool } from "@ew/tools";
import type { SkillCandidate, SkillCandidateCreate, Tool } from "@ew/shared";

export type StageSkillCandidate = (input: SkillCandidateCreate) => SkillCandidate;

export function makeStageSkillCandidateTool(
  stage: StageSkillCandidate,
  context: { threadId: string; modelId: string; memoryScope: string },
): Tool {
  return defineTool({
    name: "stage_skill_candidate",
    description:
      "把已验证、可复用的程序化工作流暂存为待审核 Skill Candidate。只暂存，不会激活；事实、偏好和一次性步骤不要使用本工具。",
    schema: z.object({
      name: z.string(),
      description: z.string(),
      triggerConditions: z.array(z.string()).min(1),
      proposedSkillMd: z.string(),
      packageFiles: z.record(z.string(), z.string()).optional(),
      requiredTools: z.array(z.string()).default([]),
      evidenceSummary: z.string(),
      reason: z.string(),
    }),
    requiresApproval: "never",
    async run(input) {
      const workspaceId = context.memoryScope.startsWith("ws:") ? context.memoryScope.slice(3) : undefined;
      const candidate = stage({
        ...input,
        requiredTools: input.requiredTools ?? [],
        scope: workspaceId ? "workspace" : "global",
        ...(workspaceId ? { workspaceId } : {}),
        sourceThreadIds: [context.threadId],
        evidence: [{ sourceThreadId: context.threadId, summary: input.evidenceSummary }],
        createdBy: "foreground-agent",
        learnerModel: context.modelId,
      });
      return {
        content: `已暂存 Skill Candidate「${candidate.name}」，状态 pending，必须由用户审核批准后才会生效。`,
        display: { kind: "skill-candidate", candidateId: candidate.id, status: candidate.status },
      };
    },
  });
}
