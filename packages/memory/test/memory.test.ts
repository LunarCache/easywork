import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { MemoryItemSchema } from "@ew/shared";
import {
  LocalMemoryProvider,
  Mem0MemoryProvider,
  type Embedder,
  type ExtractedFact,
  type FactExtractor,
} from "../src/index.js";

/** 解析 sqlite-vec 扩展路径（未安装/平台无二进制 → undefined，相关用例跳过）。 */
function vecPath(): string | undefined {
  try {
    return (
      createRequire(import.meta.url)("sqlite-vec") as { getLoadablePath(): string }
    ).getLoadablePath();
  } catch {
    return undefined;
  }
}

let dir: string | undefined;
function freshDir(): string {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ew-mem-"));
  return dir;
}
afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** 关键词向量：[cat, dog, weather]。 */
const embed: Embedder = async (texts) =>
  texts.map((t) => [/cat/i.test(t) ? 1 : 0, /dog/i.test(t) ? 1 : 0, /weather/i.test(t) ? 1 : 0]);

describe("LocalMemoryProvider", () => {
  it("shared contract rejects impossible provenance combinations", () => {
    const base = {
      id: "m1",
      layer: "user-profile" as const,
      text: "事实",
      updatedAt: new Date().toISOString(),
    };
    expect(
      MemoryItemSchema.safeParse({
        ...base,
        origin: "manual",
        state: "derived",
        sourceThreadId: "t1",
      }).success,
    ).toBe(false);
    expect(
      MemoryItemSchema.safeParse({
        ...base,
        origin: "extracted",
        state: "curated",
        sourceThreadId: "t1",
      }).success,
    ).toBe(false);
  });

  it("Mem0 boundary rejects source-owned derived facts it cannot preserve", async () => {
    const m = new Mem0MemoryProvider({ apiKey: "test", fetch: async () => new Response("{}") });
    await expect(
      m.write({
        layer: "user-profile",
        text: "来源事实",
        origin: "extracted",
        state: "derived",
        sourceThreadId: "t1",
      }),
    ).rejects.toThrow("does not support source-owned derived facts");
  });
  it("词法召回（无 embedder）", async () => {
    const m = new LocalMemoryProvider({ dir: freshDir(), dbPath: ":memory:" });
    await m.write({ layer: "agent-memory", text: "用户喜欢简洁的回答" });
    await m.write({ layer: "agent-memory", text: "天气接口用 open-meteo" });
    const hits = await m.recall({ query: "简洁 回答", topK: 1 });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.text).toContain("简洁");
    m.close();
  });

  it("向量语义召回（sqlite-vec）", async () => {
    const vp = vecPath();
    if (!vp) return; // 无预编译二进制 → 跳过（语义召回唯一引擎）
    const m = new LocalMemoryProvider({
      dir: freshDir(),
      dbPath: ":memory:",
      embed,
      vecExtensionPath: vp,
    });
    await m.write({ layer: "user-profile", text: "I have a cat named Mimi" });
    await m.write({ layer: "user-profile", text: "Today's weather is sunny" });
    const hits = await m.recall({ query: "tell me about my cat", topK: 1, minScore: 0.1 });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.text).toContain("cat");
    m.close();
  });

  it("observe 无抽取器时为 no-op（会话历史由 ConversationRepo 存档，不再写摘要）", async () => {
    const m = new LocalMemoryProvider({ dir: freshDir(), dbPath: ":memory:" });
    await m.observe({
      messages: [
        { role: "user", content: "帮我订机票" },
        { role: "assistant", content: "好的，去哪里？" },
      ],
      sessionId: "s1",
    });
    expect(await m.list()).toHaveLength(0);
    m.close();
  });

  it("observe LLM 事实抽取：写入全局层 + 与已有事实去重 + 透传 model", async () => {
    const calls: { existing: ExtractedFact[]; model?: string }[] = [];
    const extract: FactExtractor = async ({ existing, model }) => {
      calls.push({ existing, ...(model ? { model } : {}) });
      return [
        { layer: "user-profile", text: "用户是后端工程师" },
        { layer: "agent-memory", text: "项目部署在 AWS" },
        // 与已有重复（精确同文）→ 应被去重跳过
        { layer: "user-profile", text: "用户偏好简洁回答" },
        // 同批内重复 → 第二次应跳过
        { layer: "agent-memory", text: "项目部署在 AWS" },
        // 空文本 → 跳过
        { layer: "skills", text: "  " },
      ];
    };
    const m = new LocalMemoryProvider({ dir: freshDir(), dbPath: ":memory:", extract });
    await m.write({ layer: "user-profile", text: "用户偏好简洁回答" });

    await m.observe({
      messages: [
        { role: "user", content: "我是后端工程师，项目跑在 AWS" },
        { role: "assistant", content: "了解" },
      ],
      sessionId: "s1",
      model: "qwen3:4b",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.model).toBe("qwen3:4b");
    // 抽取器拿到的已有事实包含先前写入的偏好。
    expect(calls[0]!.existing.some((e) => e.text === "用户偏好简洁回答")).toBe(true);

    const profile = await m.list({ layer: "user-profile" });
    expect(profile.map((p) => p.text).sort()).toEqual(["用户偏好简洁回答", "用户是后端工程师"]);
    const agent = await m.list({ layer: "agent-memory" });
    expect(agent.map((a) => a.text)).toEqual(["项目部署在 AWS"]); // 去重后仅一条
    expect(await m.list({ layer: "skills" })).toHaveLength(0);
    m.close();
  });

  it("observe 抽取器抛错被吞掉，不影响主流程", async () => {
    const extract: FactExtractor = async () => {
      throw new Error("LLM 不可用");
    };
    const m = new LocalMemoryProvider({ dir: freshDir(), dbPath: ":memory:", extract });
    await expect(
      m.observe({ messages: [{ role: "user", content: "你好" }], sessionId: "s2" }),
    ).resolves.toBeUndefined();
    expect(await m.list()).toHaveLength(0);
    m.close();
  });

  it("edit / delete", async () => {
    const m = new LocalMemoryProvider({ dir: freshDir(), dbPath: ":memory:" });
    const w = await m.write({ layer: "agent-memory", text: "旧事实" });
    const e = await m.edit(w.id, { text: "新事实" });
    expect(e.text).toBe("新事实");
    await m.delete(w.id);
    expect(await m.list({ layer: "agent-memory" })).toHaveLength(0);
    m.close();
  });

  it("reindex：embedding 模型就绪后补算历史条目向量，召回转语义", async () => {
    let ready = false;
    const lateEmbed = async (texts: string[]) => {
      if (!ready) throw new Error("not ready");
      return texts.map((t) => [/cat/i.test(t) ? 1 : 0, /weather/i.test(t) ? 1 : 0]);
    };
    const m = new LocalMemoryProvider({ dir: freshDir(), dbPath: ":memory:", embed: lateEmbed });
    // 写入时 embedding 不可用 → 存为 null（词法）。
    await m.write({ layer: "user-profile", text: "I have a cat named Mimi" });
    await m.write({ layer: "user-profile", text: "the weather is nice" });
    // 启用 embedding 并补算。
    ready = true;
    const n = await m.reindex();
    expect(n).toBe(2);
    const hits = await m.recall({ query: "tell me about my cat", topK: 1, minScore: 0.1 });
    expect(hits[0]!.text).toContain("cat");
    m.close();
  });

  it("markdown 镜像文件生成", async () => {
    const d = freshDir();
    const m = new LocalMemoryProvider({ dir: d, dbPath: ":memory:" });
    await m.write({ layer: "user-profile", text: "用户是工程师" });
    const file = path.join(d, "user-profile.md");
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toContain("用户是工程师");
    m.close();
  });

  it("从 markdown 回灌：编辑文本 / 新增行 / 删除行", async () => {
    const d = freshDir();
    const m = new LocalMemoryProvider({ dir: d, dbPath: ":memory:", embed });
    const w = await m.write({ layer: "user-profile", text: "I have a cat" });
    const file = path.join(d, "user-profile.md");

    // 1) 编辑已有条目文本（保留 id 注释）
    fs.writeFileSync(file, `# user-profile\n\n- I have a dog <!-- ${w.id} -->\n`);
    let changed = await m.syncFromMarkdown("user-profile");
    expect(changed).toBe(true);
    let items = await m.list({ layer: "user-profile" });
    expect(items).toHaveLength(1);
    expect(items[0]!.text).toBe("I have a dog");

    // 2) 新增一行（无 id）
    fs.writeFileSync(file, `# user-profile\n\n- I have a dog <!-- ${w.id} -->\n- weather note\n`);
    changed = await m.syncFromMarkdown("user-profile");
    expect(changed).toBe(true);
    items = await m.list({ layer: "user-profile" });
    expect(items).toHaveLength(2);
    // 新增行已补上 id 注释，重嵌后可语义召回
    expect(fs.readFileSync(file, "utf8")).toMatch(/weather note <!-- [0-9a-f-]+ -->/);

    // 3) 删除一行
    fs.writeFileSync(file, `# user-profile\n\n- I have a dog <!-- ${w.id} -->\n`);
    changed = await m.syncFromMarkdown("user-profile");
    expect(changed).toBe(true);
    items = await m.list({ layer: "user-profile" });
    expect(items).toHaveLength(1);

    // 4) 无变化 → 幂等 false
    expect(await m.syncFromMarkdown("user-profile")).toBe(false);
    m.close();
  });

  it("作用域隔离：工作区之间 + 工作区独立于全局（list/recall）", async () => {
    const m = new LocalMemoryProvider({ dir: freshDir(), dbPath: ":memory:" });
    await m.write({ scope: "global", layer: "agent-memory", text: "全局：天气用 open-meteo" });
    await m.write({ scope: "ws:A", layer: "decisions", text: "A工程：迁移到 Tailwind v4" });
    await m.write({ scope: "ws:B", layer: "decisions", text: "B工程：改用 sqlite-vec" });

    // list 按作用域隔离
    expect((await m.list({ scope: "ws:A" })).map((i) => i.text)).toEqual([
      "A工程：迁移到 Tailwind v4",
    ]);
    expect((await m.list({ scope: "ws:B" })).map((i) => i.text)).toEqual([
      "B工程：改用 sqlite-vec",
    ]);
    expect((await m.list({ scope: "global" })).map((i) => i.text)).toEqual([
      "全局：天气用 open-meteo",
    ]);

    // recall 默认 global，不串入工作区
    const g = await m.recall({ query: "工程", topK: 10 });
    expect(g.every((h) => !h.text.includes("工程"))).toBe(true);
    // recall ws:A 只见 A，不见 B、不见全局
    const a = await m.recall({ query: "工程", scope: "ws:A", topK: 10 });
    expect(a.map((h) => h.text)).toEqual(["A工程：迁移到 Tailwind v4"]);
    m.close();
  });

  it("deleteByScope：清空某工作区私有池，不动全局/别的工作区", async () => {
    const m = new LocalMemoryProvider({ dir: freshDir(), dbPath: ":memory:" });
    await m.write({ scope: "global", layer: "user-profile", text: "答复简洁" });
    await m.write({ scope: "ws:A", layer: "pitfalls", text: "A坑1" });
    await m.write({ scope: "ws:A", layer: "conventions", text: "A约定1" });
    await m.write({ scope: "ws:B", layer: "pitfalls", text: "B坑1" });

    expect(await m.deleteByScope("ws:A")).toBe(2);
    expect(await m.list({ scope: "ws:A" })).toHaveLength(0);
    expect((await m.list({ scope: "ws:B" })).map((i) => i.text)).toEqual(["B坑1"]);
    expect((await m.list({ scope: "global" })).map((i) => i.text)).toEqual(["答复简洁"]);
    expect(await m.deleteByScope("ws:A")).toBe(0); // 幂等
    m.close();
  });

  it("deleteBySession：删除某会话抽取的事实，保留全局/手工事实", async () => {
    const extract: FactExtractor = async () => [
      { layer: "user-profile", text: "用户在做记忆系统" },
      { layer: "agent-memory", text: "部署在 fly.io" },
    ];
    const m = new LocalMemoryProvider({ dir: freshDir(), dbPath: ":memory:", extract });
    // 手工 / 模型主动写入（无 sessionId）—— 不应被会话删除影响。
    await m.write({ layer: "user-profile", text: "用户偏好中文" });
    // 被动抽取（带来源 sessionId=s1）。
    await m.observe({
      messages: [{ role: "user", content: "我在做记忆系统，跑在 fly.io" }],
      sessionId: "s1",
      model: "x",
    });

    expect(await m.list()).toHaveLength(3);
    const fromS1 = (await m.list({ sessionId: "s1" })).map((i) => i.text);
    expect(fromS1).toHaveLength(2);
    expect(new Set(fromS1)).toEqual(new Set(["部署在 fly.io", "用户在做记忆系统"]));

    const removed = await m.deleteBySession("s1");
    expect(removed).toBe(2);
    expect((await m.list()).map((i) => i.text)).toEqual(["用户偏好中文"]);
    // markdown 镜像同步：被删层文件不再含抽取的事实。
    expect(await m.deleteBySession("s1")).toBe(0); // 幂等
    m.close();
  });

  it("Extracted Fact 带显式来源，提升后成为独立 Curated Fact", async () => {
    const extract: FactExtractor = async () => [
      { layer: "user-profile", text: "用户偏好先给结论" },
    ];
    const m = new LocalMemoryProvider({ dir: freshDir(), dbPath: ":memory:", extract });

    const manual = await m.write({ layer: "user-profile", text: "用户偏好中文" });
    expect(manual).toMatchObject({ origin: "manual", state: "curated" });
    expect(manual.sourceThreadId).toBeUndefined();

    await m.observe({
      messages: [{ role: "user", content: "回答时先给结论" }],
      sessionId: "source-thread",
      model: "x",
    });
    const [extracted] = await m.list({ sessionId: "source-thread" });
    expect(extracted).toMatchObject({
      origin: "extracted",
      state: "derived",
      sourceThreadId: "source-thread",
    });

    const promoted = await m.promote(extracted!.id, { promotedBy: "user" });
    expect(promoted).toMatchObject({
      origin: "extracted",
      state: "curated",
      meta: {
        promotedBy: "user",
        promotedFromSourceThreadId: "source-thread",
      },
    });
    expect(promoted.sourceThreadId).toBeUndefined();
    expect(promoted.sessionId).toBeUndefined();
    expect(await m.deleteBySession("source-thread")).toBe(0);
    expect((await m.list()).map((item) => item.text).sort()).toEqual([
      "用户偏好中文",
      "用户偏好先给结论",
    ]);
    m.close();
  });

  it("拒绝不一致的来源与生命周期组合", async () => {
    const m = new LocalMemoryProvider({ dir: freshDir(), dbPath: ":memory:" });
    await expect(
      m.write({
        layer: "user-profile",
        text: "错误组合",
        origin: "manual",
        state: "derived",
        sourceThreadId: "source-thread",
      }),
    ).rejects.toThrow("derived memory must be extracted");
    await expect(
      m.write({
        layer: "user-profile",
        text: "缺来源",
        origin: "extracted",
        state: "derived",
      }),
    ).rejects.toThrow("derived memory requires sourceThreadId");
    await expect(
      m.write({
        layer: "user-profile",
        text: "curated 不应仍带来源",
        origin: "extracted",
        state: "curated",
        sourceThreadId: "source-thread",
      }),
    ).rejects.toThrow("curated memory cannot have sourceThreadId");
    expect(await m.list()).toEqual([]);
    m.close();
  });

  it("旧库迁移：有 session_id 的行变为 derived Extracted Fact，其余行安全归为 imported Curated Fact", async () => {
    const d = freshDir();
    const dbPath = path.join(d, "legacy-memory.db");
    const { DatabaseSync } = createRequire(import.meta.url)(
      "node:sqlite",
    ) as typeof import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE memory_items (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL DEFAULT 'global',
        layer TEXT NOT NULL,
        session_id TEXT,
        text TEXT NOT NULL,
        embedding BLOB,
        updated_at TEXT NOT NULL,
        meta TEXT
      );
    `);
    db.prepare(
      `INSERT INTO memory_items (id, scope, layer, session_id, text, embedding, updated_at, meta)
       VALUES (?, 'global', 'user-profile', ?, ?, NULL, ?, NULL)`,
    ).run("derived-id", "source-thread", "自动事实", "2026-01-01T00:00:00.000Z");
    db.prepare(
      `INSERT INTO memory_items (id, scope, layer, session_id, text, embedding, updated_at, meta)
       VALUES (?, 'global', 'agent-memory', NULL, ?, NULL, ?, NULL)`,
    ).run("curated-id", "既有事实", "2026-01-02T00:00:00.000Z");
    db.close();

    const m = new LocalMemoryProvider({ dir: d, dbPath });
    const items = await m.list();
    expect(items.find((item) => item.id === "derived-id")).toMatchObject({
      origin: "extracted",
      state: "derived",
      sourceThreadId: "source-thread",
    });
    expect(items.find((item) => item.id === "curated-id")).toMatchObject({
      origin: "imported",
      state: "curated",
    });
    m.close();
  });

  it("sqlite-vec 向量索引：语义召回 + 删除同步（扩展可用时）", async () => {
    const vp = vecPath();
    if (!vp) return; // 扩展不可用 → 跳过（回退 brute-force 已由上面用例覆盖）
    const m = new LocalMemoryProvider({
      dir: freshDir(),
      dbPath: ":memory:",
      embed,
      vecExtensionPath: vp,
    });
    const cat = await m.write({ layer: "user-profile", text: "I have a cat named Mimi" });
    await m.write({ layer: "user-profile", text: "Today's weather is sunny" });
    const hits = await m.recall({ query: "tell me about my cat", topK: 1, minScore: 0.1 });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.text).toContain("cat");
    // 删除后 vec 索引同步：再召回不应返回已删条目。
    await m.delete(cat.id);
    const after = await m.recall({ query: "tell me about my cat", topK: 1, minScore: 0.1 });
    expect(after.find((h) => h.text.includes("cat"))).toBeUndefined();
    m.close();
  });
});
