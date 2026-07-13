import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalMemoryProvider } from "@ew/memory";
import {
  GLOBAL_SCOPE,
  visibleScopes,
  workspaceScope,
  type ToolExecContext,
  type ToolResult,
} from "@ew/shared";
import { makeMemoryTool } from "../src/memory/memory-tool.js";
import { makeSessionSearchTool } from "../src/memory/session-search-tool.js";
import { buildMemoryManifest } from "../src/server/app.js";
import { SqliteConversationRepo } from "../src/store/conversation.js";

let dir: string | undefined;
function freshDir(): string {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ew-memtool-"));
  return dir;
}
afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const ctx: ToolExecContext = {
  sessionId: "s1",
  workspaceDir: "/tmp",
  signal: new AbortController().signal,
  approval: { request: async () => "approve" },
};
const run = (
  t: { execute: (a: unknown, c: ToolExecContext) => Promise<ToolResult> },
  args: unknown,
) => t.execute(args, ctx);

describe("manage_memory 工具", () => {
  it("add / replace / remove + 子串定位", async () => {
    const mem = new LocalMemoryProvider({ dir: freshDir(), dbPath: ":memory:" });
    const tool = makeMemoryTool(mem);

    const a = await run(tool, { action: "add", layer: "user-profile", text: "用户是后端工程师" });
    expect(a.isError).toBeFalsy();
    expect((await mem.list({ layer: "user-profile" }))[0]).toMatchObject({
      text: "用户是后端工程师",
      origin: "agent-managed",
      state: "curated",
    });

    // replace 用子串定位
    const rep = await run(tool, {
      action: "replace",
      layer: "user-profile",
      match: "后端",
      text: "用户是全栈工程师",
    });
    expect(rep.isError).toBeFalsy();
    const items = await mem.list({ layer: "user-profile" });
    expect(items).toHaveLength(1);
    expect(items[0]!.text).toBe("用户是全栈工程师");

    // remove
    const rm = await run(tool, { action: "remove", layer: "user-profile", match: "全栈" });
    expect(rm.isError).toBeFalsy();
    expect(await mem.list({ layer: "user-profile" })).toHaveLength(0);
    mem.close();
  });

  it("match 未命中 / 多义 / 缺参 → isError", async () => {
    const mem = new LocalMemoryProvider({ dir: freshDir(), dbPath: ":memory:" });
    const tool = makeMemoryTool(mem);
    await run(tool, { action: "add", layer: "agent-memory", text: "项目部署在 AWS" });
    await run(tool, { action: "add", layer: "agent-memory", text: "项目使用 TypeScript" });

    expect(
      (await run(tool, { action: "remove", layer: "agent-memory", match: "GCP" })).isError,
    ).toBe(true);
    // "项目" 同时命中两条 → 歧义报错
    expect(
      (await run(tool, { action: "remove", layer: "agent-memory", match: "项目" })).isError,
    ).toBe(true);
    // add 缺 text
    expect((await run(tool, { action: "add", layer: "agent-memory" })).isError).toBe(true);
    mem.close();
  });

  it("超字符上限 → 报错逼合并（user-profile 上限 1375）", async () => {
    const mem = new LocalMemoryProvider({ dir: freshDir(), dbPath: ":memory:" });
    const tool = makeMemoryTool(mem);
    const big = "x".repeat(1300);
    expect(
      (await run(tool, { action: "add", layer: "user-profile", text: big })).isError,
    ).toBeFalsy();
    const over = await run(tool, { action: "add", layer: "user-profile", text: "y".repeat(200) });
    expect(over.isError).toBe(true);
    expect(over.content).toContain("超限");
    mem.close();
  });

  it("replace 来源事实会把它提升为 Agent 管理的 Curated Fact", async () => {
    const mem = new LocalMemoryProvider({ dir: freshDir(), dbPath: ":memory:" });
    const source = await mem.write({
      layer: "user-profile",
      text: "用户喜欢长回答",
      origin: "extracted",
      state: "derived",
      sourceThreadId: "source-thread",
    });
    const tool = makeMemoryTool(mem);

    const result = await run(tool, {
      action: "replace",
      layer: "user-profile",
      match: "长回答",
      text: "用户喜欢先给简短结论",
    });
    expect(result.isError).toBeFalsy();
    expect((await mem.list()).find((item) => item.id === source.id)).toMatchObject({
      text: "用户喜欢先给简短结论",
      origin: "extracted",
      state: "curated",
      meta: { promotedBy: "agent", promotedFromSourceThreadId: "source-thread" },
    });
    expect(await mem.deleteBySession("source-thread")).toBe(0);
    mem.close();
  });
});

describe("session_search 工具", () => {
  it("search / browse-thread / list-threads 三态", async () => {
    const repo = new SqliteConversationRepo(":memory:");
    const t = repo.createThread({ title: "天气会话", modelId: "m" });
    const now = new Date().toISOString();
    repo.appendMessage({
      id: "u1",
      threadId: t.id,
      role: "user",
      seq: repo.nextSeq(t.id),
      parts: [{ type: "text", text: "北京天气如何" }],
      createdAt: now,
    });
    const tool = makeSessionSearchTool(repo);

    const s = await run(tool, { query: "天气" });
    expect(s.content).toContain("天气会话");

    const b = await run(tool, { thread_id: t.id });
    expect(b.content).toContain("北京天气如何");

    const l = await run(tool, {});
    expect(l.content).toContain("天气会话");

    const miss = await run(tool, { query: "不存在的关键词xyz" });
    expect(miss.content).toContain("未找到");
    repo.close();
  });
});

describe("buildMemoryManifest 记忆清单（渐进式披露）", () => {
  it("全空 → 空串；有记忆 → 列要点 + 提示用 recall_memory", async () => {
    const mem = new LocalMemoryProvider({ dir: freshDir(), dbPath: ":memory:" });
    expect(await buildMemoryManifest(mem, visibleScopes(GLOBAL_SCOPE))).toBe("");

    await mem.write({ layer: "user-profile", text: "用户是工程师" });
    await mem.write({ layer: "agent-memory", text: "项目部署在 AWS" });

    const manifest = await buildMemoryManifest(mem, visibleScopes(GLOBAL_SCOPE));
    expect(manifest).toContain("用户是工程师");
    expect(manifest).toContain("项目部署在 AWS");
    expect(manifest).toContain("recall_memory");
    mem.close();
  });

  it("作用域隔离：工作区清单不含全局 agent-memory，但含全局 user-profile（共享身份）", async () => {
    const mem = new LocalMemoryProvider({ dir: freshDir(), dbPath: ":memory:" });
    await mem.write({ scope: GLOBAL_SCOPE, layer: "user-profile", text: "答复请简洁" });
    await mem.write({
      scope: GLOBAL_SCOPE,
      layer: "agent-memory",
      text: "全局事实不该进工作区清单",
    });
    const ws = workspaceScope("proj1");
    await mem.write({ scope: ws, layer: "pitfalls", text: "并发下要串行化" });

    const manifest = await buildMemoryManifest(mem, visibleScopes(ws));
    expect(manifest).toContain("并发下要串行化"); // 本工作区
    expect(manifest).toContain("答复请简洁"); // 全局 user-profile 共享
    expect(manifest).not.toContain("全局事实不该进工作区清单"); // 全局 agent-memory 不可见
    mem.close();
  });
});
