import { describe, it, expect } from "vitest";
import type { Tool, MemoryProvider, ConversationRepo, SkillCandidateCreate } from "@ew/shared";
import type { KnowledgeBaseStore } from "../src/rag/store.js";
import { toPiTool, buildEwCustomTools, turnsForExtraction } from "../src/agent/ew-extensions.js";
import { ExtractionScheduler } from "../src/memory/extraction-scheduler.js";

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
    const builtins = [fakeTool("explore_web", async () => ({ content: "" })), fakeTool("calculator", async () => ({ content: "" }))];
    const tools = await buildEwCustomTools({ sessionId: "s", cwd: "/tmp", builtins });
    expect(tools.map((t) => t.name).sort()).toEqual(["calculator", "explore_web"]);
  });

  it("exposes a staging-only Skill Candidate tool with run provenance and workspace scope", async () => {
    let staged: SkillCandidateCreate | undefined;
    const tools = await buildEwCustomTools({
      sessionId: "source-thread",
      cwd: "/tmp",
      memoryScope: "ws:project-1",
      modelId: "model-1",
      stageSkillCandidate(input) {
        staged = input;
        const now = new Date().toISOString();
        return {
          ...input, id: "candidate-1", slug: input.name, status: "pending",
          validation: { valid: true, contentHash: "hash", findings: [], checkedAt: now }, createdAt: now, updatedAt: now,
        };
      },
    });
    const tool = tools.find((item) => item.name === "stage_skill_candidate")!;
    const result = await tool.execute("call", {
      name: "release-flow", description: "Release safely", triggerConditions: ["when releasing"],
      proposedSkillMd: "---\nname: release-flow\ndescription: Release safely\nwhenToUse: when releasing\n---\n## Procedure\n1. Test.\n## Verification\n- Check.\n",
      requiredTools: [], evidenceSummary: "worked", reason: "reusable",
    }, undefined, undefined, {} as never);
    expect(staged).toMatchObject({
      scope: "workspace", workspaceId: "project-1", sourceThreadIds: ["source-thread"],
      createdBy: "foreground-agent", learnerModel: "model-1",
    });
    expect(result.details).toMatchObject({ status: "pending", candidateId: "candidate-1" });
  });
});

describe("turnsForExtraction（含工具摘要 L5）", () => {
  it("抽取 user/assistant 文本 + 写文件/命令的工具调用摘要，忽略 thinking/其他工具", () => {
    const messages = [
      { role: "user", content: "把首页改一下" },
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "先改文件" },
          { type: "text", text: "好的，我来改" },
          { type: "toolCall", id: "1", name: "fs_write", arguments: { path: "index.html" } },
          { type: "toolCall", id: "2", name: "run_command", arguments: { command: "npm run build" } },
          { type: "toolCall", id: "3", name: "read", arguments: { path: "x" } }, // 非关键 → 忽略
        ],
      },
      { role: "toolResult", toolName: "fs_write", content: [{ type: "text", text: "ok" }] },
    ];
    const turns = turnsForExtraction(messages as never);
    expect(turns).toEqual([
      { role: "user", content: "把首页改一下" },
      { role: "assistant", content: "好的，我来改\n[写文件 index.html]\n[执行命令 npm run build]" },
    ]);
  });
});

describe("ExtractionScheduler（增量缓冲，长突发不漏；删会话丢弃）", () => {
  function recorder() {
    const observed: { messages: { role: string; content: string }[]; scope: string }[] = [];
    const sched = new ExtractionScheduler(
      async (input) => {
        observed.push({ messages: input.messages, scope: input.scope });
      },
      { idleMs: 10_000, maxTurns: 24 },
    );
    return { observed, sched };
  }

  it("30 轮连续突发（无停顿）：阈值分块 + flush 补尾，全部轮次各抽一次，无丢无重", async () => {
    const { observed, sched } = recorder();
    const convo: { role: string; content: string }[] = [];
    for (let i = 0; i < 30; i++) {
      convo.push({ role: "user", content: `u${i}` }, { role: "assistant", content: `a${i}` });
      sched.note("t1", "global", "m", convo.slice());
    }
    await sched.flushAll(); // 关停/空闲补抽尾部
    const all = observed.flatMap((o) => o.messages.map((m) => m.content));
    expect(all.length).toBe(60);
    for (let i = 0; i < 30; i++) {
      expect(all).toContain(`u${i}`);
      expect(all).toContain(`a${i}`);
    }
  });

  it("压缩致列表变短 → 重新基线，不丢失（事实去重兜重叠）", async () => {
    const { observed, sched } = recorder();
    sched.note("t1", "global", "m", [
      { role: "user", content: "u0" },
      { role: "assistant", content: "a0" },
    ]);
    // 压缩后 event.messages 变短（只剩最近一条）。
    sched.note("t1", "global", "m", [{ role: "user", content: "u1" }]);
    await sched.flush("t1");
    const all = observed.flatMap((o) => o.messages.map((m) => m.content));
    expect(all).toContain("u1");
  });

  it("discard：删会话丢弃缓冲，不抽取将删的对话", async () => {
    const { observed, sched } = recorder();
    sched.note("t1", "global", "m", [{ role: "user", content: "将删除的对话" }]);
    await sched.discard("t1");
    await sched.flushAll();
    expect(observed).toHaveLength(0);
  });

  it("discard 等待在途抽取；随后删除事实不会被迟到写入复活", async () => {
    let extractionStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      extractionStarted = resolve;
    });
    let releaseExtraction!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseExtraction = resolve;
    });
    const facts: string[] = [];
    const sched = new ExtractionScheduler(
      async ({ messages }) => {
        extractionStarted();
        await release;
        facts.push(...messages.map((message) => message.content));
      },
      { maxTurns: 1 },
    );

    sched.note("t1", "global", "m", [{ role: "user", content: "迟到事实" }]);
    await started;
    const deletion = (async () => {
      await sched.discard("t1");
      facts.length = 0;
    })();
    releaseExtraction();
    await deletion;

    expect(facts).toEqual([]);
    await sched.flushAll();
    expect(facts).toEqual([]);
  });

  it("note 透传 scope（工作区写本池）", async () => {
    const { observed, sched } = recorder();
    sched.note("wt", "ws:p1", "m", new Array(24).fill(0).map((_, i) => ({ role: "user", content: `m${i}` })));
    await sched.flushAll();
    expect(observed[0]!.scope).toBe("ws:p1");
  });
});
