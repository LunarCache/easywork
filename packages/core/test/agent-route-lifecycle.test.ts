import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { CoreHttpContext } from "../src/server/context.js";
import { registerAgentRoutes } from "../src/server/routes/agent.js";

describe("agent route adapter", () => {
  it("delegates the Agent Turn lifecycle and only frames its events as SSE", async () => {
    const app = Fastify();
    const start = vi.fn(async () => ({
      threadId: "failed-first-turn",
      events: (async function* () {
        yield { type: "error" as const, message: "model failed" };
      })(),
    }));
    const context = {
      app,
      registry: {},
      providers: { findByModel: () => ({ id: "failing" }) },
      repo: {
        getThread: () => null,
        getProject: () => null,
      },
      agentTurns: { start, isThreadDeleted: () => false },
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
      expect(start).toHaveBeenCalledWith(expect.objectContaining({
        source: expect.objectContaining({
          type: "thread",
          threadId: "failed-first-turn",
          modelId: "broken-model",
        }),
        content: [{ type: "text", text: "hello" }],
      }));
    } finally {
      await app.close();
    }
  });
});
