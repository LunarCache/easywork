import { describe, expect, it } from "vitest";
import { WorkbenchViewSession, type WorkbenchViewAdapters } from "./workbench-view-session.js";

function localAdapters(): WorkbenchViewAdapters {
  return {
    diff: { available: () => true, routeFileTargets: () => true },
    files: { resolve: (path) => ({ path, kind: "file" }), contains: () => true },
    browser: { loadHtml: async () => null },
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
