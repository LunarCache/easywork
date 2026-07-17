import { describe, expect, it } from "vitest";
import type { AgentEvent, ChatMessage } from "@ew/shared";
import {
  AgentTurnController,
  type AgentTurnRequest,
  type AgentTurnTransport,
} from "./agent-turn.js";

class InMemoryDaemonStream implements AgentTurnTransport {
  requests: AgentTurnRequest[] = [];
  approvals: { id: string; verdict: "approve" | "approve-always" | "deny" }[] = [];

  constructor(private readonly events: AgentEvent[]) {}

  async *run(request: AgentTurnRequest, _signal: AbortSignal): AsyncIterable<AgentEvent> {
    this.requests.push(request);
    yield* this.events;
  }

  async approve(id: string, verdict: "approve" | "approve-always" | "deny") {
    this.approvals.push({ id, verdict });
    return true;
  }
}

class FailingApprovalDaemonStream extends InMemoryDaemonStream {
  override async approve(): Promise<boolean> {
    throw new Error("approval transport unavailable");
  }
}

class RejectedApprovalDaemonStream extends InMemoryDaemonStream {
  override async approve(): Promise<boolean> {
    return false;
  }
}

class BlockingDaemonStream implements AgentTurnTransport {
  async *run(_request: AgentTurnRequest, signal: AbortSignal): AsyncIterable<AgentEvent> {
    yield { type: "text", text: "partial" };
    if (!signal.aborted) {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    }
    throw new Error("aborted by caller");
  }

  async approve() {
    return true;
  }
}

class GatedDaemonStream implements AgentTurnTransport {
  private releaseRun!: () => void;
  private markStarted!: () => void;
  readonly started = new Promise<void>((resolve) => {
    this.markStarted = resolve;
  });
  private readonly released = new Promise<void>((resolve) => {
    this.releaseRun = resolve;
  });

  async *run(): AsyncIterable<AgentEvent> {
    this.markStarted();
    await this.released;
    yield { type: "final", message: { role: "assistant", content: "done" } };
  }

  release() {
    this.releaseRun();
  }

  async approve() {
    return true;
  }
}

class ApprovalDaemonStream implements AgentTurnTransport {
  private releaseRun!: () => void;
  private markWaiting!: () => void;
  readonly waiting = new Promise<void>((resolve) => {
    this.markWaiting = resolve;
  });
  private readonly released = new Promise<void>((resolve) => {
    this.releaseRun = resolve;
  });

  async *run(): AsyncIterable<AgentEvent> {
    yield { type: "tool-start", call: { id: "call-1", name: "bash", arguments: '{"command":"npm test"}' } };
    yield {
      type: "approval-request",
      id: "approval-1",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "npm test" },
    };
    this.markWaiting();
    await this.released;
    yield { type: "tool-progress", callId: "call-1", stream: "stdout", chunk: "running\n" };
    yield {
      type: "tool-end",
      call: { id: "call-1", name: "bash", arguments: "" },
      result: { content: "ok", isError: false },
    };
    yield { type: "final", message: { role: "assistant", content: "done" } };
  }

  async approve(_id: string, verdict: "approve" | "approve-always" | "deny") {
    if (verdict !== "deny") this.releaseRun();
    return true;
  }
}

describe("AgentTurnController", () => {
  it("keeps the tool waiting when the daemon rejects an expired approval id", async () => {
    const daemon = new RejectedApprovalDaemonStream([
      { type: "tool-start", call: { id: "call-1", name: "bash", arguments: "{}" } },
      {
        type: "approval-request",
        id: "approval-1",
        toolCallId: "call-1",
        toolName: "bash",
        args: {},
      },
    ]);
    const controller = new AgentTurnController(daemon, {
      buildRequest: (history) => ({ model: "model-1", history }),
    });

    await controller.send({ text: "run", images: [] });
    await controller.respondApproval("approve");

    expect(controller.getState().approval?.id).toBe("approval-1");
    expect(controller.getState().messages.at(-1)?.tools[0]?.status).toBe("awaiting-approval");
  });

  it("keeps the tool waiting when approval delivery fails", async () => {
    const daemon = new FailingApprovalDaemonStream([
      { type: "tool-start", call: { id: "call-1", name: "bash", arguments: "{}" } },
      {
        type: "approval-request",
        id: "approval-1",
        toolCallId: "call-1",
        toolName: "bash",
        args: {},
      },
    ]);
    const controller = new AgentTurnController(daemon, {
      buildRequest: (history) => ({ model: "model-1", history }),
    });

    await controller.send({ text: "run", images: [] });
    await controller.respondApproval("approve");

    expect(controller.getState().approval?.id).toBe("approval-1");
    expect(controller.getState().messages.at(-1)?.tools[0]?.status).toBe("awaiting-approval");
  });

  it("queues parallel approval requests without losing their tool-call correlation", async () => {
    const daemon = new InMemoryDaemonStream([
      { type: "tool-start", call: { id: "call-1", name: "bash", arguments: "{}" } },
      { type: "tool-start", call: { id: "call-2", name: "write", arguments: "{}" } },
      {
        type: "approval-request",
        id: "approval-1",
        toolCallId: "call-1",
        toolName: "bash",
        args: {},
      },
      {
        type: "approval-request",
        id: "approval-2",
        toolCallId: "call-2",
        toolName: "write",
        args: {},
      },
    ]);
    const controller = new AgentTurnController(daemon, {
      buildRequest: (history) => ({ model: "model-1", history }),
    });

    await controller.send({ text: "run both", images: [] });

    expect(controller.getState().approval?.id).toBe("approval-1");
    expect(controller.getState().messages.at(-1)?.tools.map((tool) => tool.status)).toEqual([
      "awaiting-approval",
      "awaiting-approval",
    ]);

    await controller.respondApproval("approve");
    expect(controller.getState().approval?.id).toBe("approval-2");
    expect(controller.getState().messages.at(-1)?.tools.map((tool) => tool.status)).toEqual([
      "running",
      "awaiting-approval",
    ]);

    await controller.respondApproval("deny");
    expect(controller.getState().approval).toBeNull();
    expect(daemon.approvals).toEqual([
      { id: "approval-1", verdict: "approve" },
      { id: "approval-2", verdict: "deny" },
    ]);
  });

  it("removes a queued approval when its tool ends before the prompt is shown", async () => {
    const daemon = new InMemoryDaemonStream([
      { type: "tool-start", call: { id: "call-1", name: "bash", arguments: "{}" } },
      { type: "tool-start", call: { id: "call-2", name: "write", arguments: "{}" } },
      {
        type: "approval-request",
        id: "approval-1",
        toolCallId: "call-1",
        toolName: "bash",
        args: {},
      },
      {
        type: "approval-request",
        id: "approval-2",
        toolCallId: "call-2",
        toolName: "write",
        args: {},
      },
      {
        type: "tool-end",
        call: { id: "call-2", name: "write", arguments: "" },
        result: { content: "approval timed out", isError: true },
      },
    ]);
    const controller = new AgentTurnController(daemon, {
      buildRequest: (history) => ({ model: "model-1", history }),
    });

    await controller.send({ text: "run both", images: [] });
    await controller.respondApproval("approve");

    expect(controller.getState().approval).toBeNull();
    expect(controller.getState().messages.at(-1)?.tools.map((tool) => tool.status)).toEqual([
      "running",
      "error",
    ]);
  });

  it("keeps a tool out of the running state until its approval is granted", async () => {
    const daemon = new ApprovalDaemonStream();
    const controller = new AgentTurnController(daemon, {
      buildRequest: (history) => ({ model: "model-1", history }),
    });
    const statuses: string[] = [];
    controller.subscribe((state) => {
      const status = state.messages.at(-1)?.tools[0]?.status;
      if (status && statuses.at(-1) !== status) statuses.push(status);
    });

    const run = controller.send({ text: "run tests", images: [] });
    await daemon.waiting;

    expect(controller.getState().approval).toMatchObject({
      id: "approval-1",
      toolCallId: "call-1",
    });
    expect(controller.getState().messages.at(-1)?.tools[0]?.status).toBe("awaiting-approval");
    expect(statuses).toEqual(["pending", "awaiting-approval"]);

    await controller.respondApproval("approve");
    await run;

    expect(statuses).toEqual(["pending", "awaiting-approval", "running", "done"]);
  });

  it("owns a complete streamed turn while the view supplies its run policy", async () => {
    const daemon = new InMemoryDaemonStream([
      { type: "retry", attempt: 1, maxAttempts: 3 },
      { type: "compaction", phase: "start" },
      { type: "reasoning", text: "checking" },
      { type: "text", text: "done" },
      { type: "usage", usage: { promptTokens: 8, completionTokens: 2, totalTokens: 10 } },
      { type: "artifacts", artifacts: [{ path: "report.html", kind: "created", size: 42 }] },
      {
        type: "approval-request",
        id: "approval-1",
        toolCallId: "call-1",
        toolName: "run_command",
        args: { command: "npm test" },
      },
      { type: "final", message: { role: "assistant", content: "done" } },
    ]);
    const completed: string[] = [];
    const notices: (string | null)[] = [];
    const controller = new AgentTurnController(daemon, {
      buildRequest(history: ChatMessage[], regenerate: boolean) {
        return {
          threadId: "thread-1",
          model: "model-1",
          history,
          projectId: "project-1",
          thinkingLevel: "medium",
          ...(regenerate ? { regenerate: true } : {}),
        };
      },
      onComplete: () => completed.push("complete"),
    });
    controller.subscribe((state) => notices.push(state.notice));

    const started = await controller.send({ text: "ship it", images: [] });

    expect(started).toBe(true);
    expect(daemon.requests).toHaveLength(1);
    expect(daemon.requests[0]?.history).toEqual([{ role: "user", content: "ship it" }]);
    expect(controller.getState()).toMatchObject({
      busy: false,
      notice: null,
      usage: { promptTokens: 8, completionTokens: 2, totalTokens: 10 },
      approval: { id: "approval-1", toolName: "run_command", args: { command: "npm test" } },
    });
    expect(controller.getState().messages).toMatchObject([
      { role: "user", raw: "ship it" },
      {
        role: "assistant",
        raw: "done",
        reasoning: "checking",
        artifacts: [{ path: "report.html", kind: "created", size: 42 }],
      },
    ]);
    expect(controller.getState().messages[1]?.end).toEqual(expect.any(Number));
    expect(completed).toEqual(["complete"]);
    expect(notices).toContain("重试中 (1/3)…");
    expect(notices).toContain("压缩上下文中…");

    await controller.respondApproval("approve");
    expect(controller.getState().approval).toBeNull();
    expect(daemon.approvals).toEqual([{ id: "approval-1", verdict: "approve" }]);
  });

  it("regenerates from the last user turn and replaces the old assistant answer", async () => {
    const daemon = new InMemoryDaemonStream([
      { type: "error", message: "provider warning" },
      { type: "final", message: { role: "assistant", content: "new answer" } },
    ]);
    const controller = new AgentTurnController(daemon, {
      buildRequest: (history, regenerate) => ({ model: "model-1", history, regenerate }),
    });
    controller.restore([
      { role: "user", raw: "question", reasoning: "", tools: [] },
      { role: "assistant", raw: "old answer", reasoning: "", tools: [] },
    ]);

    expect(await controller.retry()).toBe(true);

    expect(daemon.requests[0]).toMatchObject({ regenerate: true });
    expect(daemon.requests[0]?.history.at(-1)).toEqual({ role: "user", content: "question" });
    expect(controller.getState().messages).toHaveLength(2);
    expect(controller.getState().messages[1]?.raw).toBe("\n\n[错误] provider warning");
  });

  it("cancels an active turn without reporting the abort as a request failure", async () => {
    const completed: string[] = [];
    const controller = new AgentTurnController(new BlockingDaemonStream(), {
      buildRequest: (history) => ({ model: "model-1", history }),
      onComplete: () => completed.push("complete"),
    });

    const run = controller.send({ text: "long task", images: [] });
    await Promise.resolve();
    await Promise.resolve();
    controller.stop();
    await run;

    expect(controller.getState().busy).toBe(false);
    expect(controller.getState().approval).toBeNull();
    expect(controller.getState().messages[1]).toMatchObject({ raw: "partial", cancelled: true });
    expect(controller.getState().messages[1]?.raw).not.toContain("请求失败");
    expect(completed).toEqual([]);
  });

  it("keeps workspace sequencing and refreshes behind policy callbacks", async () => {
    const order: string[] = [];
    const daemon = new InMemoryDaemonStream([
      { type: "tool-start", call: { id: "call-1", name: "fs_write", arguments: "{}" } },
      {
        type: "tool-end",
        call: { id: "call-1", name: "fs_write", arguments: "{}" },
        result: { content: "ok", isError: false },
      },
      { type: "final", message: { role: "assistant", content: "saved" } },
    ]);
    const originalRun = daemon.run.bind(daemon);
    daemon.run = (request, signal) => {
      order.push("run");
      return originalRun(request, signal);
    };
    const controller = new AgentTurnController(daemon, {
      buildRequest: (history) => ({ model: "model-1", history, projectId: "project-1" }),
      beforeRun: async () => {
        order.push("before");
      },
      onToolEnd: () => order.push("tool-end"),
      onComplete: () => order.push("complete"),
    });

    await controller.send({ text: "write", images: [] });

    expect(order).toEqual(["before", "run", "tool-end", "complete"]);
    expect(controller.getState().messages[1]?.tools[0]).toMatchObject({ name: "fs_write", status: "done" });
  });

  it("keeps one policy snapshot for the whole turn when the view rerenders", async () => {
    const daemon = new GatedDaemonStream();
    const completed: string[] = [];
    const controller = new AgentTurnController(daemon, {
      buildRequest: (history) => ({ model: "old-model", history }),
      onComplete: () => completed.push("old"),
    });

    const run = controller.send({ text: "go", images: [] });
    await daemon.started;
    controller.setPolicy({
      buildRequest: (history) => ({ model: "new-model", history }),
      onComplete: () => completed.push("new"),
    });
    daemon.release();
    await run;

    expect(completed).toEqual(["old"]);
  });
});
