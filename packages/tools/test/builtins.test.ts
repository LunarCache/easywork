import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolExecContext } from "@ew/shared";
import { exploreWebTool } from "../src/builtins.js";

function ctx(): ToolExecContext {
  return {
    sessionId: "test",
    workspaceDir: "/tmp",
    signal: new AbortController().signal,
    approval: { request: async () => "approve" },
  };
}

function duckDuckGoHtml(count: number): string {
  return Array.from(
    { length: count },
    (_, i) =>
      `<a class="result__a" href="https://example.com/${i}">Result ${i}</a>` +
      `<a class="result__snippet">Snippet ${i}</a>`,
  ).join("\n");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("explore_web", () => {
  it("exposes the renamed tool and defaults to five results", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(duckDuckGoHtml(8), { status: 200 })));

    expect(exploreWebTool.definition.name).toBe("explore_web");
    const result = await exploreWebTool.execute({ query: "easywork" }, ctx());

    expect(result.isError).toBeFalsy();
    expect(result.display).toHaveLength(5);
  });

  it("honors max_results within the bounded result window", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(duckDuckGoHtml(8), { status: 200 })));

    const result = await exploreWebTool.execute({ query: "easywork", max_results: 3 }, ctx());

    expect(result.isError).toBeFalsy();
    expect(result.display).toHaveLength(3);
  });

  it("rejects result counts outside 1-10", async () => {
    const result = await exploreWebTool.execute({ query: "easywork", max_results: 11 }, ctx());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("参数校验失败");
  });
});
