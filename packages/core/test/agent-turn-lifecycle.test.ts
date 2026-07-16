import { describe, expect, it, vi } from "vitest";
import { SqliteConversationRepo } from "../src/store/conversation.js";
import { AgentTurnLifecycle } from "../src/agent/turn-lifecycle.js";

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe("AgentTurnLifecycle", () => {
  it("withholds the HTTP final event until the canonical trajectory commits", async () => {
    const repo = new SqliteConversationRepo(":memory:");
    let releaseCommit!: () => void;
    let markCommitStarted!: () => void;
    const commitReady = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const commitStarted = new Promise<void>((resolve) => {
      markCommitStarted = resolve;
    });
    try {
      const lifecycle = new AgentTurnLifecycle({
        repo,
        sourceConversations: {
          claimRun: async (input) => {
            repo.createThread({ id: input.threadId, modelId: input.modelId, title: input.title });
            return { generation: 1, attempt: 1, created: true };
          },
          claimChannelRun: vi.fn(),
          discardEmpty: vi.fn(),
        },
        sessionHost: {
          isThreadDeleted: () => false,
          run: async function* () {
            yield { type: "text" as const, text: "streamed" };
            yield { type: "final" as const, message: { role: "assistant" as const, content: "done" } };
          },
          commitThread: async (_threadId, commit) => {
            markCommitStarted();
            await commitReady;
            await commit();
            return true;
          },
        },
        skillLifecycle: {
          learnedIdForToolCall: () => undefined,
          recordTelemetry: vi.fn(),
          schedule: vi.fn(),
        },
      });
      const execution = await lifecycle.start({
        source: {
          type: "thread",
          threadId: "http-final-gate",
          modelId: "model-a",
          title: "Final gate",
          runWorkspaceDir: "/tmp/http-final-gate",
          workspace: false,
          memoryScope: "global",
          approvalMode: "auto-edits",
        },
        content: [{ type: "text", text: "hello" }],
      });
      const iterator = execution!.events[Symbol.asyncIterator]();
      await expect(iterator.next()).resolves.toEqual({ value: { type: "text", text: "streamed" }, done: false });
      const final = iterator.next();
      await expect(Promise.race([
        commitStarted.then(() => "commit-started"),
        final.then(() => "final-published"),
      ])).resolves.toBe("commit-started");
      releaseCommit();
      await expect(final).resolves.toEqual({
        value: { type: "final", message: { role: "assistant", content: "done" } },
        done: false,
      });
      await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
    } finally {
      repo.close();
    }
  });

  it("keeps an accepted channel submission when the Agent Turn fails", async () => {
    const repo = new SqliteConversationRepo(":memory:");
    const schedule = vi.fn();
    const recordTelemetry = vi.fn();
    try {
      const lifecycle = new AgentTurnLifecycle({
        repo,
        sourceConversations: {
          claimRun: vi.fn(),
          claimChannelRun: async (input, accept) => {
            const thread = repo.resolveThreadForChannel(input.kind, input.channelUserId, {
              modelId: input.defaultModelId,
            });
            accept(thread);
            return { thread, generation: 3, attempt: 1, created: true };
          },
          discardEmpty: vi.fn(),
        },
        sessionHost: {
          isThreadDeleted: () => false,
          run: async function* () {
            yield { type: "error" as const, message: "provider unavailable" };
          },
          commitThread: vi.fn(),
        },
        skillLifecycle: {
          learnedIdForToolCall: () => undefined,
          recordTelemetry,
          schedule,
        },
      });

      const execution = await lifecycle.start({
        source: {
          type: "channel",
          kind: "wechat",
          channelUserId: "wxid-alice",
          defaultModelId: "model-a",
        },
        content: [{ type: "text", text: "hello from WeChat" }],
      });

      expect(execution).not.toBeNull();
      await expect(collect(execution!.events)).resolves.toEqual([
        { type: "error", message: "provider unavailable" },
      ]);
      expect(repo.history(execution!.threadId).map((message) => ({
        role: message.role,
        text: message.parts[0]?.type === "text" ? message.parts[0].text : "",
      }))).toEqual([{ role: "user", text: "hello from WeChat" }]);
      expect(schedule).not.toHaveBeenCalled();
      expect(recordTelemetry).not.toHaveBeenCalled();
    } finally {
      repo.close();
    }
  });

  it("does not commit Agent output when the runtime throws after emitting final", async () => {
    const repo = new SqliteConversationRepo(":memory:");
    const commitThread = vi.fn();
    const schedule = vi.fn();
    try {
      const lifecycle = new AgentTurnLifecycle({
        repo,
        sourceConversations: {
          claimRun: vi.fn(),
          claimChannelRun: async (input, accept) => {
            const thread = repo.resolveThreadForChannel(input.kind, input.channelUserId, {
              modelId: input.defaultModelId,
            });
            accept(thread);
            return { thread, generation: 3, attempt: 1, created: true };
          },
          discardEmpty: vi.fn(),
        },
        sessionHost: {
          isThreadDeleted: () => false,
          run: async function* () {
            yield { type: "final" as const, message: { role: "assistant" as const, content: "premature" } };
            throw new Error("artifact snapshot failed");
          },
          commitThread,
        },
        skillLifecycle: {
          learnedIdForToolCall: () => undefined,
          recordTelemetry: vi.fn(),
          schedule,
        },
      });

      const execution = await lifecycle.start({
        source: {
          type: "channel",
          kind: "wechat",
          channelUserId: "wxid-tail-error",
          defaultModelId: "model-a",
        },
        content: [{ type: "text", text: "create an artifact" }],
      });

      await expect(collect(execution!.events)).resolves.toEqual([
        { type: "error", message: "artifact snapshot failed" },
      ]);
      expect(repo.history(execution!.threadId)).toHaveLength(1);
      expect(commitThread).not.toHaveBeenCalled();
      expect(schedule).not.toHaveBeenCalled();
    } finally {
      repo.close();
    }
  });

  it("does not publish buffered channel output when deletion rejects the commit", async () => {
    const repo = new SqliteConversationRepo(":memory:");
    const schedule = vi.fn();
    try {
      const lifecycle = new AgentTurnLifecycle({
        repo,
        sourceConversations: {
          claimRun: vi.fn(),
          claimChannelRun: async (input, accept) => {
            const thread = repo.resolveThreadForChannel(input.kind, input.channelUserId, {
              modelId: input.defaultModelId,
            });
            accept(thread);
            return { thread, generation: 5, attempt: 1, created: true };
          },
          discardEmpty: vi.fn(),
        },
        sessionHost: {
          isThreadDeleted: () => false,
          run: async function* () {
            yield { type: "text" as const, text: "must stay private" };
            yield { type: "final" as const, message: { role: "assistant" as const, content: "done" } };
          },
          commitThread: async () => false,
        },
        skillLifecycle: {
          learnedIdForToolCall: () => undefined,
          recordTelemetry: vi.fn(),
          schedule,
        },
      });

      const execution = await lifecycle.start({
        source: {
          type: "channel",
          kind: "wechat",
          channelUserId: "wxid-deleted",
          defaultModelId: "model-a",
        },
        content: [{ type: "text", text: "delete races this turn" }],
      });

      await expect(collect(execution!.events)).resolves.toEqual([
        { type: "error", message: "thread_deleted" },
      ]);
      expect(repo.history(execution!.threadId)).toHaveLength(1);
      expect(schedule).not.toHaveBeenCalled();
    } finally {
      repo.close();
    }
  });

  it("reserves rapid channel turns in FIFO order before their event streams are consumed", async () => {
    const repo = new SqliteConversationRepo(":memory:");
    const runOrder: string[] = [];
    const modelOrder: string[] = [];
    try {
      repo.resolveThreadForChannel("wechat", "wxid-fifo", { modelId: "provider:pi-native:model-a" });
      const lifecycle = new AgentTurnLifecycle({
        repo,
        sourceConversations: {
          claimRun: vi.fn(),
          claimChannelRun: async (input, accept) => {
            const thread = repo.resolveThreadForChannel(input.kind, input.channelUserId, {
              modelId: input.defaultModelId,
            });
            accept(thread);
            return { thread, generation: 6, attempt: 1, created: false };
          },
          discardEmpty: vi.fn(),
        },
        sessionHost: {
          isThreadDeleted: () => false,
          run: async function* (input) {
            runOrder.push(input.text);
            modelOrder.push(input.modelId);
            yield { type: "final" as const, message: { role: "assistant" as const, content: input.text } };
          },
          commitThread: async (_threadId, commit) => {
            await commit();
            return true;
          },
        },
        skillLifecycle: {
          learnedIdForToolCall: () => undefined,
          recordTelemetry: vi.fn(),
          schedule: vi.fn(),
        },
      });
      const source = {
        type: "channel" as const,
        kind: "wechat" as const,
        channelUserId: "wxid-fifo",
        defaultModelId: "",
      };
      const first = await lifecycle.start({ source, content: [{ type: "text", text: "first" }] });
      let secondResolved = false;
      const secondPromise = lifecycle
        .start({ source, content: [{ type: "text", text: "second" }] })
        .then((execution) => {
          secondResolved = true;
          return execution;
        });

      await Promise.resolve();
      expect(secondResolved).toBe(false);
      await collect(first!.events);
      const second = await secondPromise;
      await collect(second!.events);
      expect(runOrder).toEqual(["first", "second"]);
      expect(modelOrder).toEqual(["provider:pi-native:model-a", "provider:pi-native:model-a"]);
    } finally {
      repo.close();
    }
  });

  it("keeps post-commit observers and learning failures non-fatal", async () => {
    const repo = new SqliteConversationRepo(":memory:");
    try {
      const lifecycle = new AgentTurnLifecycle({
        repo,
        sourceConversations: {
          claimRun: vi.fn(),
          claimChannelRun: async (input, accept) => {
            const thread = repo.resolveThreadForChannel(input.kind, input.channelUserId, {
              modelId: input.defaultModelId,
            });
            accept(thread);
            return { thread, generation: 7, attempt: 1, created: true };
          },
          discardEmpty: vi.fn(),
        },
        sessionHost: {
          isThreadDeleted: () => false,
          run: async function* () {
            yield { type: "final" as const, message: { role: "assistant" as const, content: "committed" } };
          },
          commitThread: async (_threadId, commit) => {
            await commit();
            return true;
          },
        },
        skillLifecycle: {
          learnedIdForToolCall: () => undefined,
          recordTelemetry: vi.fn(),
          schedule: () => {
            throw new Error("learning unavailable");
          },
        },
      });
      const execution = await lifecycle.start({
        source: {
          type: "channel",
          kind: "wechat",
          channelUserId: "wxid-observer",
          defaultModelId: "model-a",
        },
        content: [{ type: "text", text: "hello" }],
        onMessagesCommitted: () => {
          throw new Error("observer unavailable");
        },
      });

      await expect(collect(execution!.events)).resolves.toEqual([
        { type: "final", message: { role: "assistant", content: "committed" } },
      ]);
      expect(repo.history(execution!.threadId)).toHaveLength(2);
    } finally {
      repo.close();
    }
  });

  it("commits the canonical channel trajectory before publishing artifacts and scheduling learning", async () => {
    const repo = new SqliteConversationRepo(":memory:");
    const order: string[] = [];
    const schedule = vi.fn(() => order.push("schedule"));
    const recordTelemetry = vi.fn(() => order.push("telemetry"));
    const onMessagesCommitted = vi.fn((phase: "submission" | "result") => order.push(phase));
    try {
      const lifecycle = new AgentTurnLifecycle({
        repo,
        sourceConversations: {
          claimRun: vi.fn(),
          claimChannelRun: async (input, accept) => {
            const thread = repo.resolveThreadForChannel(input.kind, input.channelUserId, {
              modelId: input.defaultModelId,
            });
            accept(thread);
            return { thread, generation: 4, attempt: 1, created: true };
          },
          discardEmpty: vi.fn(),
        },
        sessionHost: {
          isThreadDeleted: () => false,
          run: async function* () {
            yield { type: "reasoning" as const, text: "inspect" };
            yield {
              type: "tool-start" as const,
              call: { id: "call-1", name: "read", arguments: { path: "README.md" } },
            };
            yield {
              type: "tool-end" as const,
              call: { id: "call-1", name: "read", arguments: { path: "README.md" } },
              result: { toolCallId: "call-1", content: "contents", isError: false },
            };
            yield { type: "final" as const, message: { role: "assistant" as const, content: "done" } };
            yield {
              type: "artifacts" as const,
              artifacts: [{ path: "report.md", kind: "created" as const, size: 12 }],
            };
          },
          commitThread: async (_threadId, commit) => {
            await commit();
            order.push("commit");
            return true;
          },
        },
        skillLifecycle: {
          learnedIdForToolCall: () => "learned-read",
          recordTelemetry,
          schedule,
        },
      });

      const execution = await lifecycle.start({
        source: {
          type: "channel",
          kind: "wechat",
          channelUserId: "wxid-bob",
          defaultModelId: "model-a",
        },
        content: [{ type: "text", text: "inspect the README" }],
        onMessagesCommitted,
      });
      const events = await collect(execution!.events);

      expect(repo.history(execution!.threadId).map((message) => ({
        role: message.role,
        toolCalls: message.toolCalls?.map((call) => call.name),
        toolResults: message.toolResults?.map((result) => result.toolCallId),
        artifacts: message.artifacts?.map((artifact) => artifact.path),
      }))).toEqual([
        { role: "user", toolCalls: undefined, toolResults: undefined, artifacts: undefined },
        { role: "assistant", toolCalls: ["read"], toolResults: undefined, artifacts: undefined },
        { role: "tool", toolCalls: undefined, toolResults: ["call-1"], artifacts: undefined },
        { role: "assistant", toolCalls: undefined, toolResults: undefined, artifacts: ["report.md"] },
      ]);
      expect(events.at(-1)).toEqual({
        type: "artifacts",
        artifacts: [{ path: "report.md", kind: "created", size: 12 }],
      });
      expect(order).toEqual(["submission", "commit", "result", "telemetry", "schedule"]);
    } finally {
      repo.close();
    }
  });

  it("discards a failed first transactional Agent Turn without persisting its submission", async () => {
    const repo = new SqliteConversationRepo(":memory:");
    const discardEmpty = vi.fn(async (threadId: string) => repo.deleteThread(threadId));
    const schedule = vi.fn();
    try {
      const lifecycle = new AgentTurnLifecycle({
        repo,
        sourceConversations: {
          claimRun: async (input) => {
            const created = !repo.getThread(input.threadId);
            if (created) repo.createThread({
              id: input.threadId,
              modelId: input.modelId,
              title: input.title,
              ...(input.projectId ? { projectId: input.projectId } : {}),
            });
            return { generation: 8, attempt: 1, created };
          },
          claimChannelRun: vi.fn(),
          discardEmpty,
        },
        sessionHost: {
          isThreadDeleted: () => false,
          run: async function* () {
            yield await Promise.reject(new Error("model crashed"));
          },
          commitThread: vi.fn(),
        },
        skillLifecycle: {
          learnedIdForToolCall: () => undefined,
          recordTelemetry: vi.fn(),
          schedule,
        },
      });

      const execution = await lifecycle.start({
        source: {
          type: "thread",
          threadId: "first-turn",
          modelId: "model-a",
          title: "First turn",
          runWorkspaceDir: "/tmp/easywork-first-turn",
          workspace: false,
          memoryScope: "global",
          approvalMode: "auto-edits",
        },
        content: [{ type: "text", text: "hello" }],
      });

      expect(execution).not.toBeNull();
      await expect(collect(execution!.events)).resolves.toEqual([
        { type: "error", message: "model crashed" },
      ]);
      expect(discardEmpty).toHaveBeenCalledWith("first-turn", {
        generation: 8,
        attempt: 1,
        created: true,
      });
      expect(repo.getThread("first-turn")).toBeNull();
      expect(schedule).not.toHaveBeenCalled();
    } finally {
      repo.close();
    }
  });
});
