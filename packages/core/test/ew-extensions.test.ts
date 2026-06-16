import { describe, it, expect } from "vitest";
import type { Tool, MemoryProvider, ConversationRepo } from "@ew/shared";
import type { KnowledgeBaseStore } from "../src/rag/store.js";
import { toPiTool, buildEwCustomTools } from "../src/agent/ew-extensions.js";

function fakeTool(name: string, run: Tool["execute"]): Tool {
  return {
    definition: { name, description: `${name} desc`, parameters: { type: "object", properties: {} } },
    source: "builtin",
    requiresApproval: "never",
    execute: run,
  };
}

describe("toPiTool", () => {
  it("maps name/description and wraps JSON Schema as typebox parameters", () => {
    const p = toPiTool(fakeTool("t", async () => ({ content: "ok" })), { sessionId: "s", cwd: "/tmp" });
    expect(p.name).toBe("t");
    expect(p.description).toBe("t desc");
    // Type.Unsafe 透传原 JSON Schema 字段。
    expect((p.parameters as { type?: string }).type).toBe("object");
  });

  it("success → AgentToolResult with content array + details", async () => {
    const p = toPiTool(fakeTool("t", async () => ({ content: "hello", display: { kind: "x" } })), {
      sessionId: "s",
      cwd: "/tmp",
    });
    const r = await p.execute("c1", {}, undefined, undefined, {} as never);
    expect(r).toEqual({ content: [{ type: "text", text: "hello" }], details: { kind: "x" } });
  });

  it("isError result → throws (pi 以抛出表达工具错误)", async () => {
    const p = toPiTool(fakeTool("t", async () => ({ content: "boom", isError: true })), {
      sessionId: "s",
      cwd: "/tmp",
    });
    await expect(p.execute("c1", {}, undefined, undefined, {} as never)).rejects.toThrow("boom");
  });

  it("ContentPart[] content → mapped (text + image), others dropped", async () => {
    const p = toPiTool(
      fakeTool("t", async () => ({
        content: [
          { type: "text", text: "a" },
          { type: "image", mimeType: "image/png", data: "b64" },
        ],
      })),
      { sessionId: "s", cwd: "/tmp" },
    );
    const r = await p.execute("c1", {}, undefined, undefined, {} as never);
    expect(r.content).toEqual([
      { type: "text", text: "a" },
      { type: "image", data: "b64", mimeType: "image/png" },
    ]);
  });

  it("passes sessionId/cwd into the underlying tool ctx", async () => {
    let seen: { sessionId: string; workspaceDir: string } | null = null;
    const p = toPiTool(
      fakeTool("t", async (_args, ctx) => {
        seen = { sessionId: ctx.sessionId, workspaceDir: ctx.workspaceDir };
        return { content: "ok" };
      }),
      { sessionId: "thread-9", cwd: "/work/dir" },
    );
    await p.execute("c1", {}, undefined, undefined, {} as never);
    expect(seen).toEqual({ sessionId: "thread-9", workspaceDir: "/work/dir" });
  });
});

describe("buildEwCustomTools", () => {
  it("includes memory/session/kb tools per provided deps", async () => {
    const memory = {} as MemoryProvider;
    const repo = {} as ConversationRepo;
    const kb = {} as KnowledgeBaseStore;
    const tools = await buildEwCustomTools({ sessionId: "s", cwd: "/tmp", memory, repo, kb });
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["manage_memory", "recall_memory", "search_knowledge_base", "session_search"]);
  });

  it("empty when no deps", async () => {
    const tools = await buildEwCustomTools({ sessionId: "s", cwd: "/tmp" });
    expect(tools).toEqual([]);
  });

  it("bridges builtin tools (R5: web/util tools preserved)", async () => {
    const builtins = [fakeTool("web_search", async () => ({ content: "" })), fakeTool("calculator", async () => ({ content: "" }))];
    const tools = await buildEwCustomTools({ sessionId: "s", cwd: "/tmp", builtins });
    expect(tools.map((t) => t.name).sort()).toEqual(["calculator", "web_search"]);
  });
});
