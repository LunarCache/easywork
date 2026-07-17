import { randomUUID } from "node:crypto";
import type { ApprovalGate, ApprovalVerdictResult } from "@ew/shared";

/**
 * 跨请求的待审批登记表：/agent/run 的 SSE 流发起审批请求并挂起，
 * /agent/approve 端点据 id 解析，唤醒对应 promise。
 */
export class ApprovalRegistry {
  private readonly pending = new Map<string, (v: ApprovalVerdictResult) => void>();

  register(id: string, resolve: (v: ApprovalVerdictResult) => void): void {
    this.pending.set(id, resolve);
  }

  /** 客户端回应：解析对应审批。未知 id 返回 false。 */
  resolve(id: string, verdict: ApprovalVerdictResult): boolean {
    const r = this.pending.get(id);
    if (!r) return false;
    this.pending.delete(id);
    r(verdict);
    return true;
  }

  cancel(id: string): void {
    this.pending.delete(id);
  }
}

export interface SseApprovalOptions {
  registry: ApprovalRegistry;
  /** 向 SSE 流发出 approval-request 事件。 */
  emit: (ev: { type: "approval-request"; id: string; toolCallId: string; toolName: string; args: unknown }) => void;
  signal?: AbortSignal;
  /** 超时（毫秒）未回应则按 deny。默认 120s。 */
  timeoutMs?: number;
}

/**
 * 交互式审批门：每次 request() 生成 id，发出 SSE 事件并挂起，
 * 等待 /agent/approve 解析或超时/中断（按 deny 处理）。
 */
export class SseApprovalGate implements ApprovalGate {
  constructor(private readonly opts: SseApprovalOptions) {}

  request(req: { toolCallId: string; toolName: string; args: unknown }): Promise<ApprovalVerdictResult> {
    const id = randomUUID();
    const timeoutMs = this.opts.timeoutMs ?? 120_000;
    return new Promise<ApprovalVerdictResult>((resolve) => {
      let settled = false;
      const done = (v: ApprovalVerdictResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.opts.registry.cancel(id);
        if (this.opts.signal) this.opts.signal.removeEventListener("abort", onAbort);
        resolve(v);
      };
      const onAbort = (): void => done("deny");
      const timer = setTimeout(() => done("deny"), timeoutMs);
      this.opts.registry.register(id, done);
      if (this.opts.signal) {
        if (this.opts.signal.aborted) return done("deny");
        this.opts.signal.addEventListener("abort", onAbort);
      }
      this.opts.emit({
        type: "approval-request",
        id,
        toolCallId: req.toolCallId,
        toolName: req.toolName,
        args: req.args,
      });
    });
  }
}
