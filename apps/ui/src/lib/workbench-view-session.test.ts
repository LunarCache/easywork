import { describe, expect, it, vi } from "vitest";
import { WorkbenchViewSession, type WorkbenchViewAdapters } from "./workbench-view-session.js";

function localAdapters(): WorkbenchViewAdapters {
  return {
    diff: { available: () => true, routeFileTargets: () => true },
    files: { resolve: (path) => ({ path, kind: "file" }), contains: () => true },
    browser: { loadHtml: async () => null, closeSurface: vi.fn(async () => undefined) },
  };
}

describe("WorkbenchViewSession", () => {
  it("owns opening, activation, adjacent close fallback, and the empty-view lifecycle", async () => {
    const adapters = localAdapters();
    const session = new WorkbenchViewSession(adapters);

    expect(session.getState()).toEqual({ views: [], activeViewId: null, error: null });

    await session.open("browser");
    await session.open("diff");
    session.activate("preview");
    expect(session.getState()).toMatchObject({
      activeViewId: "preview",
      views: [
        { id: "preview", kind: "browser" },
        { id: "diff", kind: "diff" },
      ],
    });

    await session.close("preview");
    expect(session.getState().views.some((view) => view.kind === "browser")).toBe(false);
    expect(session.getState().activeViewId).toBe("diff");
    expect(adapters.browser.closeSurface).toHaveBeenCalledOnce();
    await session.close("diff");
    expect(session.getState()).toMatchObject({ views: [], activeViewId: null });
  });

  it("routes browser addresses and file targets through their view adapters", async () => {
    const adapters = localAdapters();
    adapters.files.resolve = (path) => ({
      path: path === "/tmp/report.html" ? "report.html" : path,
      kind: path.endsWith(".html") ? "html" : "file",
    });
    adapters.browser.loadHtml = async (path) =>
      path === "report.html" ? { kind: "html", name: "report.html", html: "<h1>Report</h1>" } : null;
    const session = new WorkbenchViewSession(adapters);

    expect(await session.navigate({ kind: "browser", url: "example.com/docs" })).toEqual({
      status: "navigated",
      destination: "browser",
      url: "https://example.com/docs",
    });
    expect(session.getState()).toMatchObject({
      activeViewId: "preview",
      views: [{ id: "preview", page: { kind: "url", url: "https://example.com/docs" } }],
    });
    expect(await session.navigate({ kind: "browser", url: "file:///etc/passwd" })).toEqual({ status: "rejected" });
    expect(session.getState().views[0]).toMatchObject({ page: { url: "https://example.com/docs" } });

    expect(await session.navigate({ kind: "file", path: "/tmp/report.html" })).toEqual({
      status: "navigated",
      destination: "browser",
    });
    expect(session.getState().views[0]).toMatchObject({
      page: { kind: "html", name: "report.html", html: "<h1>Report</h1>" },
    });
    await session.clearBrowser();
    expect(session.getState().views[0]).toMatchObject({ page: null });

    await session.navigate({ kind: "file", path: "src/index.ts" });
    expect(session.getState().activeViewId).toBe("diff");

    await session.navigate({ kind: "file", path: "src/index.ts", mode: "browse" });
    expect(session.getState().activeViewId).toBe("files");
    expect(session.getState().views.find((view) => view.kind === "files")).toMatchObject({
      selection: { path: "src/index.ts", retainWhenUnlisted: false },
    });
    adapters.files.contains = () => false;
    session.reconcileFiles();
    expect(session.getState().views.find((view) => view.kind === "files")).toMatchObject({ selection: null });

    const surfaceCloseCalls = vi.mocked(adapters.browser.closeSurface).mock.calls.length;
    await session.dispose();
    expect(adapters.browser.closeSurface).toHaveBeenCalledTimes(surfaceCloseCalls + 1);
  });
});
