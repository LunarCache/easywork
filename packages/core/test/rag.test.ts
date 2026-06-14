import { describe, it, expect } from "vitest";
import { chunkText } from "../src/rag/chunking.js";
import { KnowledgeBaseStore } from "../src/rag/store.js";
import { ragAutoInject, formatHits } from "../src/rag/tool.js";
import { parseFile } from "../src/rag/parse.js";

// 关键词向量：[cat, dog, weather]
const embed = async (texts: string[]) =>
  texts.map((t) => [/cat/i.test(t) ? 1 : 0, /dog/i.test(t) ? 1 : 0, /weather/i.test(t) ? 1 : 0]);

describe("RAG chunking", () => {
  it("按标题/段落切分并带重叠", () => {
    const text = "# 标题\n\n第一段内容。\n\n第二段内容。\n\n" + "x".repeat(2000);
    const chunks = chunkText(text, { maxTokens: 50, overlapTokens: 10 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.index).toBe(0);
  });

  it("空文本 → 无分块", () => {
    expect(chunkText("   ")).toEqual([]);
  });
});

describe("KnowledgeBaseStore", () => {
  it("摄取 + 词法检索（无 embedder）", async () => {
    const kb = new KnowledgeBaseStore({ dbPath: ":memory:" });
    await kb.ingest({ source: "doc1.md", text: "EasyWork 是本地 AI 工作台。支持工具调用与记忆。" });
    expect(kb.count()).toBeGreaterThan(0);
    const hits = await kb.retrieve("EasyWork 工作台");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.source).toBe("doc1.md");
    kb.close();
  });

  it("混合检索（注入 embedder）按语义召回", async () => {
    const kb = new KnowledgeBaseStore({ dbPath: ":memory:", embed });
    await kb.ingest({ source: "pets.md", text: "I have a cat named Mimi." });
    await kb.ingest({ source: "weather.md", text: "The weather is sunny today." });
    const hits = await kb.retrieve("tell me about my cat", { topK: 1 });
    expect(hits[0]!.source).toBe("pets.md");
    kb.close();
  });

  it("多集合：按 kbId 作用域检索 + listKbs + 全集合检索", async () => {
    const kb = new KnowledgeBaseStore({ dbPath: ":memory:" });
    await kb.ingest({ kbId: "products", source: "p.md", text: "EasyWork 产品支持本地推理。" });
    await kb.ingest({ kbId: "legal", source: "l.md", text: "隐私政策与许可条款说明。" });
    const kbs = kb.listKbs();
    expect(kbs.map((k) => k.kbId).sort()).toEqual(["legal", "products"]);

    // 限定 products 集合 → 不应命中 legal
    const inProducts = await kb.retrieve("产品 推理", { kbId: "products" });
    expect(inProducts.every((h) => h.source === "p.md")).toBe(true);

    // 跨全部集合
    const all = await kb.retrieve("隐私", {});
    expect(all.some((h) => h.source === "l.md")).toBe(true);
    expect(kb.count()).toBeGreaterThan(kb.count("products"));
    kb.close();
  });

  it("listDocs / deleteDoc", async () => {
    const kb = new KnowledgeBaseStore({ dbPath: ":memory:" });
    const d = await kb.ingest({ source: "a.md", text: "内容内容内容" });
    expect(kb.listDocs()).toHaveLength(1);
    kb.deleteDoc(d.id);
    expect(kb.listDocs()).toHaveLength(0);
    expect(kb.count()).toBe(0);
    kb.close();
  });
});

describe("文件解析 parseFile", () => {
  it("文本/markdown/json 解码为文本", () => {
    expect(parseFile("a.md", Buffer.from("# 标题\n正文", "utf8"))).toContain("正文");
    expect(parseFile("b.txt", Buffer.from("hello", "utf8"))).toBe("hello");
    expect(parseFile("c.json", Buffer.from('{"k":1}', "utf8"))).toContain('"k"');
  });
  it("html 去标签", () => {
    expect(parseFile("p.html", Buffer.from("<p>你好<b>世界</b></p>", "utf8"))).toBe("你好 世界");
  });
  it("PDF / 二进制类型报清晰错误", () => {
    expect(() => parseFile("x.pdf", Buffer.from("%PDF-1.4"))).toThrow(/PDF/);
    expect(() => parseFile("x.docx", Buffer.from("PK"))).toThrow(/不支持/);
    // 含大量 NUL 的无扩展名文件视为二进制
    expect(() => parseFile("blob", Buffer.from([0, 0, 0, 0, 65, 0, 0, 0]))).toThrow();
  });
});

describe("RAG 工具与自动注入", () => {
  it("formatHits 生成 <chunk> 块 + 来源 display", () => {
    const { content, display } = formatHits([
      { text: "片段A", source: "a.md", docId: "d", chunkIndex: 0, score: 0.9 },
    ]);
    expect(content).toContain('<chunk id="1" source="a.md">');
    expect((display as { sources: unknown[] }).sources).toHaveLength(1);
  });

  it("ragAutoInject：空库返回 null；有命中返回上下文", async () => {
    const kb = new KnowledgeBaseStore({ dbPath: ":memory:" });
    expect(await ragAutoInject(kb, "任何问题")).toBeNull();
    await kb.ingest({ source: "doc.md", text: "EasyWork 支持 MCP 与 Skills。" });
    const inj = await ragAutoInject(kb, "EasyWork 支持什么", { minScore: 0 });
    expect(inj).not.toBeNull();
    expect(inj!.context).toContain("<chunk");
    expect(inj!.sources.length).toBeGreaterThan(0);
    kb.close();
  });
});
