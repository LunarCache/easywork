import { describe, expect, it } from "vitest";
import { WorkbenchViewSession, type WorkbenchViewAdapters } from "./workbench-view-session.js";
import type { TerminalSessionInfo } from "./terminal-runtime.js";

function localAdapters(): WorkbenchViewAdapters {
  return {
    diff: { available: () => true, routeFileTargets: () => true },
    files: { resolve: (path) => ({ path, kind: "file" }), contains: () => true },
    browser: { loadHtml: async () => null },
    terminal: {
      available: false,
      list: async () => [],
      create: async () => {
        throw new Error("terminal unavailable");
      },
      close: async () => "closed",
      confirmClose: async () => false,
    },
  };
}

describe("WorkbenchViewSession", () => {
  it("owns opening, activation, adjacent close fallback, and the empty-view lifecycle", async () => {
    let emptied = 0;
    const session = new WorkbenchViewSession({
      defaultView: () => "files",
      adapters: localAdapters(),
      onEmpty: () => {
        emptied += 1;
      },
    });

    await session.open("browser");
    await session.open("diff");
    session.activate("preview");
    expect(session.getState()).toMatchObject({
      activeViewId: "preview",
      views: [
        { id: "files", kind: "files" },
        { id: "preview", kind: "browser" },
        { id: "diff", kind: "diff" },
      ],
    });

    await session.close("preview");
    expect(session.getState().activeViewId).toBe("diff");
    await session.close("files");
    await session.close("diff");
    expect(session.getState()).toMatchObject({ views: [], activeViewId: null });
    expect(emptied).toBe(1);

    session.ensureVisible(true);
    expect(session.getState()).toMatchObject({
      activeViewId: "files",
      views: [{ id: "files", kind: "files" }],
    });
  });

  it("restores only runtime terminals and owns terminal close confirmation", async () => {
    const sessions: TerminalSessionInfo[] = [
      { sessionId: "term-1", scope: "workspace:one", title: "终端 1", cwd: "/workspace" },
    ];
    const closeCalls: { id: string; force: boolean }[] = [];
    let confirmed = false;
    const adapters = localAdapters();
    adapters.terminal = {
      available: true,
      list: async () => [...sessions],
      create: async () => {
        const session = {
          sessionId: "term-2",
          scope: "workspace:one",
          title: "终端 2",
          cwd: "/workspace",
        };
        sessions.push(session);
        return session;
      },
      close: async (id, force = false) => {
        closeCalls.push({ id, force });
        if (id === "term-2" && !force) return "confirmation_required";
        const index = sessions.findIndex((session) => session.sessionId === id);
        if (index >= 0) sessions.splice(index, 1);
        return "closed";
      },
      confirmClose: async () => confirmed,
    };
    const session = new WorkbenchViewSession({ defaultView: () => "files", adapters, onEmpty: () => {} });

    await session.restore();
    await session.open("browser");
    await session.open("terminal");
    expect(session.getState()).toMatchObject({
      activeViewId: "terminal-term-2",
      views: [
        { id: "files" },
        { id: "terminal-term-1", kind: "terminal" },
        { id: "preview", kind: "browser" },
        { id: "terminal-term-2", kind: "terminal" },
      ],
    });

    expect(await session.close("terminal-term-2")).toBe(false);
    expect(session.getState().activeViewId).toBe("terminal-term-2");
    confirmed = true;
    expect(await session.close("terminal-term-2")).toBe(true);
    expect(closeCalls.slice(-2)).toEqual([
      { id: "term-2", force: false },
      { id: "term-2", force: true },
    ]);

    const afterReload = new WorkbenchViewSession({ defaultView: () => "files", adapters, onEmpty: () => {} });
    await afterReload.restore();
    expect(afterReload.getState().views).toMatchObject([
      { id: "files" },
      { id: "terminal-term-1", kind: "terminal" },
    ]);
  });

  it("routes browser addresses and file targets through their view adapters", async () => {
    const adapters = localAdapters();
    adapters.files.resolve = (path) => ({
      path: path === "/tmp/report.html" ? "report.html" : path,
      kind: path.endsWith(".html") ? "html" : "file",
    });
    adapters.browser.loadHtml = async (path) =>
      path === "report.html" ? { kind: "html", name: "report.html", html: "<h1>Report</h1>" } : null;
    const session = new WorkbenchViewSession({ defaultView: () => "files", adapters, onEmpty: () => {} });

    expect(await session.navigate({ kind: "browser", url: "example.com/docs" })).toEqual({
      status: "navigated",
      destination: "browser",
      url: "https://example.com/docs",
    });
    expect(session.getState()).toMatchObject({
      activeViewId: "preview",
      views: [
        { id: "files" },
        { id: "preview", page: { kind: "url", url: "https://example.com/docs" } },
      ],
    });
    expect(await session.navigate({ kind: "browser", url: "file:///etc/passwd" })).toEqual({ status: "rejected" });
    expect(session.getState().views[1]).toMatchObject({ page: { url: "https://example.com/docs" } });

    expect(await session.navigate({ kind: "file", path: "/tmp/report.html" })).toEqual({
      status: "navigated",
      destination: "browser",
    });
    expect(session.getState().views[1]).toMatchObject({
      page: { kind: "html", name: "report.html", html: "<h1>Report</h1>" },
    });
    session.clearBrowser();
    expect(session.getState().views[1]).toMatchObject({ page: null });

    await session.navigate({ kind: "file", path: "src/index.ts" });
    expect(session.getState().activeViewId).toBe("diff");

    await session.navigate({ kind: "file", path: "src/index.ts", mode: "browse" });
    expect(session.getState().activeViewId).toBe("files");
    expect(session.getState().views.find((view) => view.kind === "files")).toMatchObject({
      selection: { path: "src/index.ts", retainWhenUnlisted: false },
    });
    adapters.files.contains = () => false;
    session.reconcileFiles();
    expect(session.getState().views[0]).toMatchObject({ kind: "files", selection: null });
  });
});
