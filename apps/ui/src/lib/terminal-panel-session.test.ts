import { describe, expect, it } from "vitest";
import { TerminalPanelSession, type TerminalPanelAdapters } from "./terminal-panel-session.js";
import type { TerminalSessionInfo } from "./terminal-runtime.js";

function terminal(id: string): TerminalSessionInfo {
  return { sessionId: id, scope: "workspace:one", title: `终端 ${id.slice(-1)}`, cwd: "/workspace" };
}

describe("TerminalPanelSession", () => {
  it("restores runtime sessions and creates the first terminal when the panel opens empty", async () => {
    const runtimeSessions = [terminal("term-1")];
    const adapters: TerminalPanelAdapters = {
      list: async () => [...runtimeSessions],
      create: async () => {
        const created = terminal("term-2");
        runtimeSessions.push(created);
        return created;
      },
      close: async () => "closed",
      confirmClose: async () => false,
    };

    const restored = new TerminalPanelSession(adapters);
    await restored.show();
    expect(restored.getState()).toMatchObject({
      activeSessionId: "term-1",
      sessions: [{ sessionId: "term-1" }],
    });

    runtimeSessions.length = 0;
    const empty = new TerminalPanelSession(adapters);
    await empty.show();
    expect(empty.getState()).toMatchObject({
      activeSessionId: "term-2",
      sessions: [{ sessionId: "term-2" }],
    });
  });

  it("owns multi-session activation, adjacent close fallback, and foreground-task confirmation", async () => {
    const runtimeSessions = [terminal("term-1")];
    let confirmed = false;
    const closeCalls: Array<{ id: string; force: boolean }> = [];
    const session = new TerminalPanelSession({
      list: async () => [...runtimeSessions],
      create: async () => {
        const created = terminal(`term-${runtimeSessions.length + 1}`);
        runtimeSessions.push(created);
        return created;
      },
      close: async (id, force = false) => {
        closeCalls.push({ id, force });
        if (id === "term-2" && !force) return "confirmation_required";
        const index = runtimeSessions.findIndex((candidate) => candidate.sessionId === id);
        if (index >= 0) runtimeSessions.splice(index, 1);
        return "closed";
      },
      confirmClose: async () => confirmed,
    });

    await session.restore();
    await session.create();
    await session.create();
    session.activate("term-2");
    expect(session.getState().activeSessionId).toBe("term-2");

    expect(await session.close("term-2")).toBe(false);
    confirmed = true;
    expect(await session.close("term-2")).toBe(true);
    expect(session.getState()).toMatchObject({
      activeSessionId: "term-3",
      sessions: [{ sessionId: "term-1" }, { sessionId: "term-3" }],
    });
    expect(closeCalls.slice(-2)).toEqual([
      { id: "term-2", force: false },
      { id: "term-2", force: true },
    ]);
  });

  it("does not create a duplicate terminal when runtime restoration fails", async () => {
    let createCalls = 0;
    const session = new TerminalPanelSession({
      list: async () => {
        throw new Error("IPC unavailable");
      },
      create: async () => {
        createCalls += 1;
        return terminal("term-2");
      },
      close: async () => "closed",
      confirmClose: async () => false,
    });

    await session.show();

    expect(createCalls).toBe(0);
    expect(session.getState()).toMatchObject({ sessions: [], error: "IPC unavailable" });
  });
});
