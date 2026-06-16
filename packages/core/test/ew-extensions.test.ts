import { describe, it, expect } from "vitest";
import type { Tool, MemoryProvider, ConversationRepo } from "@ew/shared";
import type { KnowledgeBaseStore } from "../src/rag/store.js";
import { toPiTool, buildEwCustomTools, memoryExtensionFactory } from "../src/agent/ew-extensions.js";

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

describe("memoryExtensionFactory 批量抽取（增量缓冲，长突发不漏）", () => {
  // 假 pi：捕获注册的事件处理器。
  function fakePi() {
    const handlers: Record<string, (e: unknown) => unknown> = {};
    return { pi: { on: (e: string, h: (ev: unknown) => unknown) => (handlers[e] = h) }, handlers };
  }
  // 假记忆：list 空（清单为空），记录每次 observe 的消息。
  function fakeMemory(observed: { role: string; content: string }[][]): MemoryProvider {
    return {
      id: "fake",
      list: async () => [],
      recall: async () => [],
      write: async (i) => ({ id: "x", updatedAt: "", ...i }),
      edit: async () => ({ id: "x", layer: "user-profile", text: "", updatedAt: "" }),
      delete: async () => {},
      deleteBySession: async () => 0,
      deleteByScope: async () => 0,
      observe: async (input) => {
        observed.push(input.messages as { role: string; content: string }[]);
      },
    };
  }

  it("30 轮连续突发（无停顿）：阈值分块 + 关闭补抽，全部轮次都被抽取一次，无早期丢失", async () => {
    const observed: { role: string; content: string }[][] = [];
    const factory = memoryExtensionFactory({
      threadId: "t1",
      modelId: "m",
      scope: "global",
      memory: fakeMemory(observed),
      runtime: { mode: "approve-each", alwaysApproved: new Set() },
    });
    const { pi, handlers } = fakePi();
    factory(pi as never);

    // 模拟 30 轮：每轮 event.messages 是「迄今为止的完整对话」（user+assistant 交替）。
    const convo: { role: string; content: string }[] = [];
    for (let i = 0; i < 30; i++) {
      convo.push({ role: "user", content: `u${i}` }, { role: "assistant", content: `a${i}` });
      handlers["agent_end"]!({ messages: convo.slice() });
    }
    // 会话关闭补抽尾部缓冲。
    handlers["session_shutdown"]!({});

    const all = observed.flat().map((m) => m.content);
    // 60 条消息（30 轮 ×2）全部恰好被抽取一次，无丢失、无重复。
    expect(all.length).toBe(60);
    for (let i = 0; i < 30; i++) {
      expect(all).toContain(`u${i}`);
      expect(all).toContain(`a${i}`);
    }
  });

  it("取消的一轮不纳入抽取", async () => {
    const observed: { role: string; content: string }[][] = [];
    const runtime = { mode: "approve-each" as const, alwaysApproved: new Set<string>(), aborted: false };
    const factory = memoryExtensionFactory({ threadId: "t2", modelId: "m", scope: "global", memory: fakeMemory(observed), runtime });
    const { pi, handlers } = fakePi();
    factory(pi as never);

    handlers["agent_end"]!({ messages: [{ role: "user", content: "保留这条" }] });
    runtime.aborted = true; // 下一轮被取消
    handlers["agent_end"]!({ messages: [{ role: "user", content: "保留这条" }, { role: "user", content: "取消的轮次" }] });
    handlers["session_shutdown"]!({});

    const all = observed.flat().map((m) => m.content);
    expect(all).toContain("保留这条");
    expect(all).not.toContain("取消的轮次");
  });
});
