import { describe, it, expect } from "vitest";
import { ApprovalRegistry, SseApprovalGate } from "../src/agent/approval-sse.js";

describe("SseApprovalGate", () => {
  it("发出 approval-request 事件并在 /approve 解析后返回 verdict", async () => {
    const reg = new ApprovalRegistry();
    const events: { type: string; id: string; toolName: string }[] = [];
    const gate = new SseApprovalGate({ registry: reg, emit: (e) => events.push(e as never) });

    const p = gate.request({ toolName: "http_get", args: { url: "https://x" } });
    expect(events).toHaveLength(1);
    expect(events[0]!.toolName).toBe("http_get");
    const id = events[0]!.id;

    expect(reg.resolve(id, "approve-always")).toBe(true);
    expect(await p).toBe("approve-always");
    // 重复解析同 id 返回 false
    expect(reg.resolve(id, "deny")).toBe(false);
  });

  it("中断信号 → deny", async () => {
    const reg = new ApprovalRegistry();
    const ac = new AbortController();
    const gate = new SseApprovalGate({ registry: reg, emit: () => {}, signal: ac.signal });
    const p = gate.request({ toolName: "x", args: {} });
    ac.abort();
    expect(await p).toBe("deny");
  });

  it("超时 → deny", async () => {
    const reg = new ApprovalRegistry();
    const gate = new SseApprovalGate({ registry: reg, emit: () => {}, timeoutMs: 10 });
    const p = gate.request({ toolName: "x", args: {} });
    expect(await p).toBe("deny");
  });
});
