import type { ApprovalGate, ApprovalVerdictResult } from "@ew/shared";

/**
 * 无头/默认审批门。本地单用户场景默认放行（local-first）。
 * 阶段 D 桌面 UI 会替换为交互式审批；外部 IM 渠道可换成"危险工具默认拒绝"。
 */
export class AutoApproveGate implements ApprovalGate {
  constructor(private readonly verdict: ApprovalVerdictResult = "approve") {}
  async request(): Promise<ApprovalVerdictResult> {
    return this.verdict;
  }
}
