import { describe, expect, it } from "vitest";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { runAgentTurn } from "../src/agent/run-agent-turn.js";

function fakeSession(opts: {
  prompt?: (text: string) => Promise<void>;
  abort?: () => Promise<void>;
  initialMessages?: Array<{ role: string; content: string }>;
}) {
  let handler: ((ev: AgentSessionEvent) => void) | undefined;
  const session = {
    agent: { state: { messages: opts.initialMessages ?? [] } },
    subscribe: (h: (ev: AgentSessionEvent) => void) => {
      handler = h;
      return () => {
        handler = undefined;
      };
    },
    prompt: opts.prompt ?? (async () => {}),
    abort: opts.abort ?? (async () => {}),
  } as unknown as AgentSession;
  return {
    session,
    emit: (ev: AgentSessionEvent) => handler?.(ev),
  };
}

async function collect(iter: AsyncGenerator<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

describe("runAgentTurn", () => {
  it("yields mapped events until final agent_end", async () => {
    const fake = fakeSession({
      prompt: async () => {
        fake.emit({ type: "message_update" } as AgentSessionEvent);
        fake.emit({ type: "agent_end", willRetry: true } as AgentSessionEvent);
        fake.emit({ type: "agent_end", willRetry: false } as AgentSessionEvent);
      },
    });

    await expect(collect(runAgentTurn({
      session: fake.session,
      text: "hello",
      mapEvent: (ev) => (ev.type === "message_update" ? [{ type: "text", text: "hi" }] : []),
    }))).resolves.toEqual([{ type: "text", text: "hi" }]);
  });

  it("turns prompt failures into error events and unsubscribes", async () => {
    let unsubscribed = false;
    const session = {
      agent: { state: { messages: [] } },
      subscribe: () => () => {
        unsubscribed = true;
      },
      prompt: async () => {
        throw new Error("provider down");
      },
      abort: async () => {},
    } as unknown as AgentSession;

    const events = await collect(runAgentTurn({ session, text: "hello", mapEvent: () => [] }));
    expect(events).toEqual([{ type: "error", message: "provider down" }]);
    expect(unsubscribed).toBe(true);
  });

  it("marks abort and rolls back messages to the pre-prompt snapshot", async () => {
    let aborts = 0;
    let markAbort = 0;
    const controller = new AbortController();
    const initial = [{ role: "user", content: "before" }];
    const fake = fakeSession({
      initialMessages: initial,
      abort: async () => {
        aborts++;
        fake.emit({ type: "agent_end", willRetry: false } as AgentSessionEvent);
      },
      prompt: async () => {
        fake.session.agent.state.messages = [
          ...initial,
          { role: "user", content: "during" },
          { role: "assistant", content: "partial" },
        ] as typeof fake.session.agent.state.messages;
        controller.abort();
      },
    });

    await collect(runAgentTurn({
      session: fake.session,
      text: "hello",
      signal: controller.signal,
      mapEvent: () => [],
      onAbort: () => {
        markAbort++;
      },
    }));

    expect(aborts).toBe(1);
    expect(markAbort).toBe(1);
    expect(fake.session.agent.state.messages).toEqual(initial);
  });

  it("rolls back prompt failures so interrupted provider streams do not enter context", async () => {
    let discarded = 0;
    const initial = [{ role: "user", content: "before" }];
    const fake = fakeSession({
      initialMessages: initial,
      prompt: async () => {
        fake.session.agent.state.messages = [
          ...initial,
          { role: "user", content: "during" },
          { role: "assistant", content: "partial" },
        ] as typeof fake.session.agent.state.messages;
        throw new Error("stream interrupted");
      },
    });

    const events = await collect(runAgentTurn({
      session: fake.session,
      text: "hello",
      mapEvent: () => [],
      onDiscard: () => {
        discarded++;
      },
    }));

    expect(events).toEqual([{ type: "error", message: "stream interrupted" }]);
    expect(discarded).toBe(1);
    expect(fake.session.agent.state.messages).toEqual(initial);
  });

  it("rolls back terminal assistant errors", async () => {
    let discarded = 0;
    const initial = [{ role: "user", content: "before" }];
    const fake = fakeSession({
      initialMessages: initial,
      prompt: async () => {
        fake.session.agent.state.messages = [
          ...initial,
          { role: "user", content: "during" },
          { role: "assistant", content: "partial" },
        ] as typeof fake.session.agent.state.messages;
        fake.emit({
          type: "agent_end",
          willRetry: false,
          messages: [{ role: "assistant", stopReason: "error", errorMessage: "provider failed" }],
        } as unknown as AgentSessionEvent);
      },
    });

    await collect(runAgentTurn({
      session: fake.session,
      text: "hello",
      mapEvent: (ev) => (ev.type === "agent_end" ? [{ type: "error", message: "provider failed" }] : []),
      onDiscard: () => {
        discarded++;
      },
    }));

    expect(discarded).toBe(1);
    expect(fake.session.agent.state.messages).toEqual(initial);
  });
});
