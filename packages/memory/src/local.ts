import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type * as NodeSqlite from "node:sqlite";
import type {
  MemoryItem,
  MemoryLayer,
  MemoryProvider,
  MemoryWrite,
  RecallQuery,
} from "@ew/shared";
import { cosine, lexicalScore } from "./cosine.js";

// node:sqlite 通过 createRequire 运行时加载（避免打包器静态解析这个较新的内置模块）。
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof NodeSqlite;
type SqliteDB = InstanceType<typeof NodeSqlite.DatabaseSync>;

/** 文本批量向量化（注入 node-llama-cpp / 云端 embed）。 */
export type Embedder = (texts: string[]) => Promise<number[][]>;

/** LLM 抽取出的一条持久事实（带目标分层）。 */
export interface ExtractedFact {
  layer: "user-profile" | "agent-memory" | "skills";
  text: string;
}

/**
 * LLM 事实抽取器：对话 → 候选持久事实。注入以解耦引擎依赖（本包仅依赖 @ew/shared）。
 * 不可用/失败时应返回 [] 或抛错（observe 会吞掉，不影响主流程）。
 */
export type FactExtractor = (input: {
  messages: { role: string; content: unknown }[];
  /** 各全局层已有事实，供模型去重（避免重复抽取）。 */
  existing: ExtractedFact[];
  /** 抽取所用模型 id（通常复用当轮对话模型，已加载）。 */
  model?: string;
}) => Promise<ExtractedFact[]>;

const GLOBAL_FACT_LAYERS = ["user-profile", "agent-memory", "skills"] as const;
/** 与同层已有事实词法重叠达到此阈值则视为重复，跳过写入（防记忆膨胀）。 */
const FACT_DEDUP_THRESHOLD = 0.85;

export interface LocalMemoryOptions {
  /** 分层 markdown 目录。 */
  dir: string;
  /** SQLite 索引文件路径（:memory: 可用于测试）。 */
  dbPath: string;
  /** 可选向量化函数；缺省则用词法召回。 */
  embed?: Embedder;
  /** 可选 LLM 事实抽取器；提供则 observe 额外抽取持久事实写入全局层。 */
  extract?: FactExtractor;
}

const LAYER_FILE: Record<MemoryLayer, string> = {
  "user-profile": "user-profile.md",
  "agent-memory": "agent-memory.md",
  skills: "skills.md",
};

interface Row {
  id: string;
  layer: MemoryLayer;
  session_id: string | null;
  text: string;
  embedding: Buffer | null;
  updated_at: string;
  meta: string | null;
}

/**
 * 本地默认记忆提供商：分层 markdown（人类可读/可编辑的真相源）+ SQLite 索引 + 向量/词法召回。
 * 写操作生成 markdown 镜像；startWatching() 监听用户手工编辑并经 syncFromMarkdown 回灌索引（变更才重嵌）。
 */
export class LocalMemoryProvider implements MemoryProvider {
  readonly id = "local";
  private readonly db: SqliteDB;
  private readonly dir: string;
  private readonly embed?: Embedder;
  private readonly extract?: FactExtractor;

  constructor(opts: LocalMemoryOptions) {
    this.dir = opts.dir;
    if (opts.embed) this.embed = opts.embed;
    if (opts.extract) this.extract = opts.extract;
    fs.mkdirSync(opts.dir, { recursive: true });
    if (opts.dbPath !== ":memory:") fs.mkdirSync(path.dirname(opts.dbPath), { recursive: true });
    this.db = new DatabaseSync(opts.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_items (
        id TEXT PRIMARY KEY,
        layer TEXT NOT NULL,
        session_id TEXT,
        text TEXT NOT NULL,
        embedding BLOB,
        updated_at TEXT NOT NULL,
        meta TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_mem_layer ON memory_items(layer);
      CREATE INDEX IF NOT EXISTS idx_mem_session ON memory_items(session_id);
    `);
  }

  private toItem(r: Row): MemoryItem {
    return {
      id: r.id,
      layer: r.layer,
      text: r.text,
      ...(r.session_id ? { sessionId: r.session_id } : {}),
      updatedAt: r.updated_at,
      ...(r.meta ? { meta: JSON.parse(r.meta) as Record<string, unknown> } : {}),
    };
  }

  private async embedOne(text: string): Promise<Float32Array | null> {
    if (!this.embed) return null;
    try {
      const [vec] = await this.embed([text]);
      return vec ? Float32Array.from(vec) : null;
    } catch {
      return null;
    }
  }

  async write(item: MemoryWrite): Promise<MemoryItem> {
    const id = randomUUID();
    const updatedAt = new Date().toISOString();
    const emb = await this.embedOne(item.text);
    this.db
      .prepare(
        `INSERT INTO memory_items (id, layer, session_id, text, embedding, updated_at, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        item.layer,
        item.sessionId ?? null,
        item.text,
        emb ? Buffer.from(emb.buffer) : null,
        updatedAt,
        item.meta ? JSON.stringify(item.meta) : null,
      );
    this.regenerateMarkdown(item.layer);
    return { id, updatedAt, ...item };
  }

  async edit(id: string, patch: Partial<Pick<MemoryItem, "text" | "meta">>): Promise<MemoryItem> {
    const row = this.db.prepare(`SELECT * FROM memory_items WHERE id = ?`).get(id) as unknown as
      | Row
      | undefined;
    if (!row) throw new Error(`memory item not found: ${id}`);
    const text = patch.text ?? row.text;
    const updatedAt = new Date().toISOString();
    const emb = patch.text ? await this.embedOne(text) : row.embedding;
    const meta = patch.meta !== undefined ? JSON.stringify(patch.meta) : row.meta;
    this.db
      .prepare(`UPDATE memory_items SET text = ?, embedding = ?, updated_at = ?, meta = ? WHERE id = ?`)
      .run(text, emb instanceof Float32Array ? Buffer.from(emb.buffer) : emb, updatedAt, meta, id);
    this.regenerateMarkdown(row.layer);
    return this.toItem({ ...row, text, updated_at: updatedAt, meta });
  }

  async list(filter?: { layer?: MemoryLayer; sessionId?: string }): Promise<MemoryItem[]> {
    let sql = `SELECT * FROM memory_items`;
    const where: string[] = [];
    const params: (string | null)[] = [];
    if (filter?.layer) {
      where.push("layer = ?");
      params.push(filter.layer);
    }
    if (filter?.sessionId) {
      where.push("session_id = ?");
      params.push(filter.sessionId);
    }
    if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
    sql += ` ORDER BY updated_at DESC`;
    const rows = this.db.prepare(sql).all(...params) as unknown as Row[];
    return rows.map((r) => this.toItem(r));
  }

  async delete(id: string): Promise<void> {
    const row = this.db.prepare(`SELECT layer, session_id FROM memory_items WHERE id = ?`).get(id) as unknown as
      | { layer: MemoryLayer; session_id: string | null }
      | undefined;
    this.db.prepare(`DELETE FROM memory_items WHERE id = ?`).run(id);
    if (row) this.regenerateMarkdown(row.layer);
  }

  async recall(q: RecallQuery): Promise<MemoryItem[]> {
    const topK = q.topK ?? 6;
    const minScore = q.minScore ?? 0;
    // 候选：指定 layers，否则全部全局层。
    let rows: Row[];
    if (q.layers?.length) {
      const placeholders = q.layers.map(() => "?").join(",");
      rows = this.db
        .prepare(`SELECT * FROM memory_items WHERE layer IN (${placeholders})`)
        .all(...q.layers) as unknown as Row[];
    } else {
      rows = this.db
        .prepare(`SELECT * FROM memory_items WHERE layer IN ('user-profile','agent-memory','skills')`)
        .all() as unknown as Row[];
    }

    const queryEmb = await this.embedOne(q.query);
    // 混合召回（参考 Hermes：语义 + 词法融合）：两者皆可用时加权，否则退化为词法。
    const scored = rows.map((r) => {
      const lex = lexicalScore(q.query, r.text);
      let score: number;
      if (queryEmb && r.embedding) {
        const sem = cosine(
          queryEmb,
          new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4),
        );
        score = 0.75 * sem + 0.25 * lex;
      } else {
        score = lex;
      }
      return { item: { ...this.toItem(r), score }, score };
    });
    return scored
      .filter((s) => s.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((s) => s.item);
  }

  /**
   * 为尚未向量化的记忆条目补算 embedding（embedding 模型启用/切换后调用）。
   * 返回处理条数。`force` 为 true 时重嵌全部。
   */
  async reindex(opts: { force?: boolean; batch?: number } = {}): Promise<number> {
    if (!this.embed) return 0;
    const where = opts.force ? "" : "WHERE embedding IS NULL";
    const rows = this.db.prepare(`SELECT id, text FROM memory_items ${where}`).all() as unknown as {
      id: string;
      text: string;
    }[];
    const batch = opts.batch ?? 16;
    let done = 0;
    const update = this.db.prepare(`UPDATE memory_items SET embedding = ? WHERE id = ?`);
    for (let i = 0; i < rows.length; i += batch) {
      const slice = rows.slice(i, i + batch);
      let vectors: number[][];
      try {
        vectors = await this.embed(slice.map((r) => r.text));
      } catch {
        break; // embedding 不可用 → 停止（保持词法召回）
      }
      slice.forEach((r, j) => {
        const v = vectors[j];
        if (v) {
          update.run(Buffer.from(Float32Array.from(v).buffer), r.id);
          done++;
        }
      });
    }
    return done;
  }

  /**
   * 轮后记忆抽取：LLM 事实抽取（注入 extractor 时）——把持久的用户偏好/事实/技能写入全局层，带去重。
   * 会话历史本身由 ConversationRepo 完整存档（不再写截断的会话摘要）。
   */
  async observe(input: { messages: unknown[]; sessionId: string; model?: string }): Promise<void> {
    if (!this.extract) return;
    const msgs = input.messages as { role: string; content: unknown }[];
    await this.extractFacts(msgs, input.model);
  }

  /** LLM 抽取持久事实并去重写入全局层（失败不影响主流程）。 */
  private async extractFacts(
    messages: { role: string; content: unknown }[],
    model?: string,
  ): Promise<void> {
    if (!this.extract) return;
    try {
      const existing = this.globalFacts();
      const facts = await this.extract({
        messages,
        existing,
        ...(model ? { model } : {}),
      });
      for (const f of facts) {
        const text = f.text.trim();
        if (!text || !GLOBAL_FACT_LAYERS.includes(f.layer)) continue;
        if (this.isDuplicateFact(f.layer, text, existing)) continue;
        await this.write({ layer: f.layer, text });
        existing.push({ layer: f.layer, text }); // 同批内也去重
      }
    } catch {
      /* 抽取失败不影响摘要与主流程 */
    }
  }

  /** 读取所有全局层（user-profile/agent-memory/skills）已有事实。 */
  private globalFacts(): ExtractedFact[] {
    const placeholders = GLOBAL_FACT_LAYERS.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT layer, text FROM memory_items WHERE layer IN (${placeholders})`)
      .all(...GLOBAL_FACT_LAYERS) as unknown as { layer: ExtractedFact["layer"]; text: string }[];
    return rows.map((r) => ({ layer: r.layer, text: r.text }));
  }

  /** 候选事实是否与同层已有事实词法高度重叠（双向取大者，>= 阈值视为重复）。 */
  private isDuplicateFact(
    layer: ExtractedFact["layer"],
    text: string,
    existing: ExtractedFact[],
  ): boolean {
    for (const e of existing) {
      if (e.layer !== layer) continue;
      const sim = Math.max(lexicalScore(text, e.text), lexicalScore(e.text, text));
      if (sim >= FACT_DEDUP_THRESHOLD) return true;
    }
    return false;
  }

  private regenerateMarkdown(layer: MemoryLayer): void {
    try {
      const rows = this.db
        .prepare(`SELECT * FROM memory_items WHERE layer = ? ORDER BY updated_at`)
        .all(layer) as unknown as Row[];
      fs.writeFileSync(path.join(this.dir, LAYER_FILE[layer]), renderLayer(layer, rows));
    } catch {
      /* markdown 镜像失败不影响主流程 */
    }
  }

  /**
   * 从 markdown 回灌到索引（markdown 为真相源）。解析每层文件的 `- 文本 <!-- id -->` 行：
   * - 已有 id 且文本变化 → 更新 + 重嵌；
   * - 无 id 的新行 → 新建条目（之后 regenerate 补上 id）；
   * - 文件中不再出现的 id → 删除。
   * 幂等：无变化则不写库、不重生成 markdown（避免 watcher 自激）。
   */
  async syncFromMarkdown(layer: MemoryLayer): Promise<boolean> {
    const file = path.join(this.dir, LAYER_FILE[layer]);
    let content: string;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      return false; // 文件不存在 → 跳过
    }
    const entries = parseLayerMarkdown(content);
    const rows = this.db
      .prepare(`SELECT * FROM memory_items WHERE layer = ? ORDER BY updated_at`)
      .all(layer) as unknown as Row[];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const seenIds = new Set<string>();
    let changed = false;
    const now = new Date().toISOString();

    for (const e of entries) {
      if (e.id && byId.has(e.id)) {
        seenIds.add(e.id);
        const row = byId.get(e.id)!;
        if (row.text !== e.text) {
          const emb = await this.embedOne(e.text);
          this.db
            .prepare(`UPDATE memory_items SET text = ?, embedding = ?, updated_at = ? WHERE id = ?`)
            .run(e.text, emb ? Buffer.from(emb.buffer) : null, now, e.id);
          changed = true;
        }
      } else if (e.text.trim()) {
        // 新行（用户手工添加，无 id）
        const id = randomUUID();
        const emb = await this.embedOne(e.text);
        this.db
          .prepare(
            `INSERT INTO memory_items (id, layer, session_id, text, embedding, updated_at, meta) VALUES (?, ?, ?, ?, ?, ?, NULL)`,
          )
          .run(id, layer, null, e.text, emb ? Buffer.from(emb.buffer) : null, now);
        changed = true;
      }
    }
    // 文件中已删除的条目 → 从索引删除
    for (const r of rows) {
      if (!seenIds.has(r.id)) {
        this.db.prepare(`DELETE FROM memory_items WHERE id = ?`).run(r.id);
        changed = true;
      }
    }
    if (changed) this.regenerateMarkdown(layer);
    return changed;
  }

  /**
   * 监听 markdown 目录，用户手工编辑后自动回灌索引（去抖）。返回停止函数。
   */
  startWatching(opts: { debounceMs?: number } = {}): () => void {
    const debounce = opts.debounceMs ?? 300;
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const onChange = (layer: MemoryLayer): void => {
      const prev = timers.get(layer);
      if (prev) clearTimeout(prev);
      timers.set(
        layer,
        setTimeout(() => {
          void this.syncFromMarkdown(layer).catch(() => {});
        }, debounce),
      );
    };
    const watchers: fs.FSWatcher[] = [];
    try {
      watchers.push(
        fs.watch(this.dir, (_evt, filename) => {
          if (!filename) return;
          const fn = filename.toString();
          const layer = (Object.keys(LAYER_FILE) as MemoryLayer[]).find((l) => LAYER_FILE[l] === fn);
          if (layer) onChange(layer);
        }),
      );
    } catch {
      /* 平台不支持 fs.watch 时静默降级 */
    }
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      for (const w of watchers) w.close();
    };
  }

  close(): void {
    this.db.close();
  }
}

/** 解析一层 markdown 的条目：行形如 `- 文本 <!-- id -->`（id 可缺）。 */
function parseLayerMarkdown(content: string): { id?: string; text: string }[] {
  const out: { id?: string; text: string }[] = [];
  for (const raw of content.split("\n")) {
    const line = raw.trimEnd();
    if (!line.startsWith("- ")) continue;
    const body = line.slice(2);
    const m = /\s*<!--\s*([0-9a-fA-F-]{8,})\s*-->\s*$/.exec(body);
    if (m) {
      out.push({ id: m[1], text: body.slice(0, m.index).trim() });
    } else {
      out.push({ text: body.trim() });
    }
  }
  return out;
}

function renderLayer(title: string, rows: Row[]): string {
  const lines = rows.map((r) => `- ${r.text.replace(/\n/g, " ")} <!-- ${r.id} -->`);
  return `# ${title}\n\n${lines.join("\n")}\n`;
}

