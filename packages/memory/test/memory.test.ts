import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LocalMemoryProvider,
  type Embedder,
  type ExtractedFact,
  type FactExtractor,
} from "../src/index.js";

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
  it("词法召回（无 embedder）", async () => {
    const m = new LocalMemoryProvider({ dir: freshDir(), dbPath: ":memory:" });
    await m.write({ layer: "agent-memory", text: "用户喜欢简洁的回答" });
    await m.write({ layer: "agent-memory", text: "天气接口用 open-meteo" });
    const hits = await m.recall({ query: "简洁 回答", topK: 1 });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.text).toContain("简洁");
    m.close();
  });

  it("向量语义召回（注入 embedder）", async () => {
    const m = new LocalMemoryProvider({ dir: freshDir(), dbPath: ":memory:", embed });
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
});
