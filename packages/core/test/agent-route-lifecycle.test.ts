import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { CoreHttpContext } from "../src/server/context.js";
import { registerAgentRoutes } from "../src/server/routes/agent.js";

describe("agent route Source Conversation lifecycle", () => {
  it("routes a failed first turn through empty-shell cleanup", async () => {
    const app = Fastify();
    const threads = new Map<string, { id: string; title: string; modelId: string; projectId: string | null }>();
    const discardEmpty = vi.fn(async (threadId: string) => {
      threads.delete(threadId);
    });
    let receivedGeneration: number | undefined;
    const context = {
      app,
      registry: {},
      providers: { findByModel: () => ({ id: "failing" }) },
      repo: {
        getThread: (id: string) => threads.get(id) ?? null,
        createThread: (input: { id: string; title: string; modelId: string; projectId?: string }) => {
          const thread = { ...input, projectId: input.projectId ?? null };
          threads.set(input.id, thread);
          return thread;
        },
        history: () => [],
      },
      sessionHost: {
        isThreadDeleted: () => false,
        threadGeneration: () => 7,
        run: async function* (input: { threadGeneration?: number }) {
          receivedGeneration = input.threadGeneration;
          yield* [];
          throw new Error("model failed");
        },
      },
      sourceConversations: {
        claimRun: async (input: { threadId: string; title: string; modelId: string; projectId?: string }) => {
          const created = !threads.has(input.threadId);
          if (created) threads.set(input.threadId, { ...input, id: input.threadId, projectId: input.projectId ?? null });
          return { generation: 7, attempt: 1, created };
        },
        delete: vi.fn(),
        discardEmpty,
        deleteProject: vi.fn(),
      },
      skillCandidates: {
        learnedIdForToolCall: () => undefined,
        recordTelemetry: vi.fn(),
      },
      skillLearning: { schedule: vi.fn() },
    } as unknown as CoreHttpContext;
    registerAgentRoutes(context);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/agent/run",
        payload: {
          threadId: "failed-first-turn",
          model: "broken-model",
          history: [{ role: "user", content: "hello" }],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("model failed");
      expect(receivedGeneration).toBe(7);
      expect(discardEmpty).toHaveBeenCalledWith("failed-first-turn", { generation: 7, attempt: 1, created: true });
      expect(threads.has("failed-first-turn")).toBe(false);
    } finally {
      await app.close();
    }
  });
});
