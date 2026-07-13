import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type * as NodeSqlite from "node:sqlite";
import {
  GLOBAL_LAYERS,
  GLOBAL_SCOPE,
  MemoryWriteSchema,
  layersForScope,
  type MemoryItem,
  type MemoryLayer,
  type MemoryProvider,
  type MemoryWrite,
  type RecallQuery,
} from "@ew/shared";
import { lexicalScore } from "./cosine.js";
import { SqliteVecIndex } from "./vec-index.js";

// node:sqlite 通过 createRequire 运行时加载（避免打包器静态解析这个较新的内置模块）。
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof NodeSqlite;
type SqliteDB = InstanceType<typeof NodeSqlite.DatabaseSync>;

/** 文本批量向量化（注入 llama-server / 云端 embed）。 */
export type Embedder = (texts: string[]) => Promise<number[][]>;

/** LLM 抽取出的一条持久事实（带目标分层）。 */
export interface ExtractedFact {
  layer: MemoryLayer;
  text: string;
}

/**
 * LLM 事实抽取器：对话 → 候选持久事实。注入以解耦引擎依赖（本包仅依赖 @ew/shared）。
 * 提示词按 scope 切换（工作区盯「变动/约束/坑」，对话盯「身份/偏好/技巧」）。
 * 不可用/失败时应返回 [] 或抛错（observe 会吞掉，不影响主流程）。
 */
export type FactExtractor = (input: {
  messages: { role: string; content: unknown }[];
  /** 同作用域已有事实，供模型去重（避免重复抽取）。 */
  existing: ExtractedFact[];
  /** 本作用域允许写入的分层。 */
  layers: readonly MemoryLayer[];
  /** 作用域（global / ws:<id>），供抽取器切换提示词。 */
  scope: string;
  /** 抽取所用模型 id（通常复用当轮对话模型，已加载）。 */
  model?: string;
}) => Promise<ExtractedFact[]>;

/** 与同层已有事实词法重叠达到此阈值则视为重复，跳过写入（防记忆膨胀）。 */
const FACT_DEDUP_THRESHOLD = 0.85;

export interface LocalMemoryOptions {
  /** 分层 markdown 目录（仅全局作用域生成镜像，可手工编辑）。 */
  dir: string;
  /** SQLite 索引文件路径（:memory: 可用于测试）。 */
  dbPath: string;
  /** 可选向量化函数；缺省则用词法召回。 */
  embed?: Embedder;
  /** 可选 LLM 事实抽取器；提供则 observe 额外抽取持久事实写入对应作用域。 */
  extract?: FactExtractor;
  /**
   * sqlite-vec 可加载扩展（.dylib/.so/.dll）路径。语义召回唯一引擎（已移除 JS 余弦 brute-force）：
   * 提供且加载成功 → cosine KNN 向量索引；缺失/平台不支持 → 无语义分，召回退化为纯词法。
   */
  vecExtensionPath?: string;
}

/** 仅全局作用域有 markdown 镜像（人类可读/可编辑）；工作区记忆为 DB-only。 */
const LAYER_FILE: Record<(typeof GLOBAL_LAYERS)[number], string> = {
  "user-profile": "user-profile.md",
  "agent-memory": "agent-memory.md",
  skills: "skills.md",
};

interface Row {
  rowid?: number | bigint;
  id: string;
  scope: string;
  layer: MemoryLayer;
  session_id: string | null;
  origin: MemoryItem["origin"];
  lifecycle_state: MemoryItem["state"];
  source_thread_id: string | null;
  text: string;
  embedding: Buffer | null;
  updated_at: string;
  meta: string | null;
}

/**
 * 本地默认记忆提供商：作用域化（global 对话池 + 每工作区独立池）的分层记忆。
 * 全局作用域生成 markdown 镜像（真相源，可手工编辑回灌）；语义召回走 sqlite-vec。
 */
export class LocalMemoryProvider implements MemoryProvider {
  readonly id = "local";
  private readonly db: SqliteDB;
  private readonly dir: string;
  private readonly embed?: Embedder;
  private readonly extract?: FactExtractor;
  /** sqlite-vec 向量索引（语义召回唯一引擎）；未提供扩展路径时为 undefined → 纯词法。 */
  private readonly vec?: SqliteVecIndex;

  constructor(opts: LocalMemoryOptions) {
    this.dir = opts.dir;
    if (opts.embed) this.embed = opts.embed;
    if (opts.extract) this.extract = opts.extract;
    fs.mkdirSync(opts.dir, { recursive: true });
    if (opts.dbPath !== ":memory:") fs.mkdirSync(path.dirname(opts.dbPath), { recursive: true });
    this.db = opts.vecExtensionPath
      ? new DatabaseSync(opts.dbPath, { allowExtension: true })
      : new DatabaseSync(opts.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_items (
        id TEXT PRIMARY KEY,
        layer TEXT NOT NULL,
        session_id TEXT,
        origin TEXT NOT NULL DEFAULT 'manual',
        lifecycle_state TEXT NOT NULL DEFAULT 'curated',
        source_thread_id TEXT,
        text TEXT NOT NULL,
        embedding BLOB,
        updated_at TEXT NOT NULL,
        meta TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_mem_layer ON memory_items(layer);
      CREATE INDEX IF NOT EXISTS idx_mem_session ON memory_items(session_id);
    `);
    // 迁移：旧库无 scope 列 → 加上并把存量归入 global。
    const cols = this.db.prepare(`PRAGMA table_info(memory_items)`).all() as unknown as {
      name: string;
    }[];
    if (!cols.some((c) => c.name === "scope")) {
      this.db.exec(
        `ALTER TABLE memory_items ADD COLUMN scope TEXT NOT NULL DEFAULT '${GLOBAL_SCOPE}'`,
      );
    }
    if (!cols.some((c) => c.name === "origin")) {
      this.db.exec(`ALTER TABLE memory_items ADD COLUMN origin TEXT`);
    }
    if (!cols.some((c) => c.name === "lifecycle_state")) {
      this.db.exec(`ALTER TABLE memory_items ADD COLUMN lifecycle_state TEXT`);
    }
    if (!cols.some((c) => c.name === "source_thread_id")) {
      this.db.exec(`ALTER TABLE memory_items ADD COLUMN source_thread_id TEXT`);
    }
    // 旧行无法区分手工与 foreground agent 写入，安全归为 imported；带 session_id 的旧行是来源事实。
    this.db.exec(`
      UPDATE memory_items
      SET origin = CASE WHEN session_id IS NOT NULL THEN 'extracted' ELSE 'imported' END
      WHERE origin IS NULL OR origin = '';
      UPDATE memory_items
      SET lifecycle_state = CASE WHEN session_id IS NOT NULL THEN 'derived' ELSE 'curated' END
      WHERE lifecycle_state IS NULL OR lifecycle_state = '';
      UPDATE memory_items
      SET source_thread_id = session_id
      WHERE source_thread_id IS NULL AND session_id IS NOT NULL AND lifecycle_state = 'derived';
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_mem_scope ON memory_items(scope)`);
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_mem_source_thread ON memory_items(source_thread_id)`,
    );
    if (opts.vecExtensionPath) {
      this.vec = new SqliteVecIndex(this.db, "vec_items");
      this.vec.load(opts.vecExtensionPath); // 失败抛出：sqlite-vec 是必备依赖
    }
  }

  /** 回填源：把 memory_items 里所有 embedding blob 喂回 vec 索引（维度变化重建时用）。 */
  private repopulateVec = (add: (rowid: number | bigint, buf: Buffer) => void): void => {
    const rows = this.db
      .prepare(`SELECT rowid, embedding FROM memory_items WHERE embedding IS NOT NULL`)
      .all() as unknown as { rowid: number | bigint; embedding: Buffer }[];
    for (const r of rows) add(r.rowid, r.embedding);
  };

  private vecSet(rowid: number | bigint | undefined, buf: Buffer | null): void {
    this.vec?.set(rowid, buf, this.repopulateVec);
  }

  private toItem(r: Row): MemoryItem {
    const sourceThreadId = r.source_thread_id ?? r.session_id ?? undefined;
    return {
      id: r.id,
      scope: r.scope,
      layer: r.layer,
      text: r.text,
      origin: r.origin,
      state: r.lifecycle_state,
      ...(sourceThreadId ? { sourceThreadId, sessionId: sourceThreadId } : {}),
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
    MemoryWriteSchema.parse(item);
    const id = randomUUID();
    const scope = item.scope ?? GLOBAL_SCOPE;
    const updatedAt = new Date().toISOString();
    const sourceThreadId = item.sourceThreadId ?? item.sessionId;
    const origin = item.origin ?? (sourceThreadId ? "extracted" : "manual");
    const state = item.state ?? (origin === "extracted" && sourceThreadId ? "derived" : "curated");
    if (state === "derived") {
      if (origin !== "extracted") throw new Error("derived memory must be extracted");
      if (!sourceThreadId) throw new Error("derived memory requires sourceThreadId");
    } else if (sourceThreadId) {
      throw new Error("curated memory cannot have sourceThreadId");
    }
    const emb = await this.embedOne(item.text);
    const buf = emb ? Buffer.from(emb.buffer) : null;
    const info = this.db
      .prepare(
        `INSERT INTO memory_items
           (id, scope, layer, session_id, origin, lifecycle_state, source_thread_id, text, embedding, updated_at, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        scope,
        item.layer,
        state === "derived" ? (sourceThreadId ?? null) : null,
        origin,
        state,
        state === "derived" ? (sourceThreadId ?? null) : null,
        item.text,
        buf,
        updatedAt,
        item.meta ? JSON.stringify(item.meta) : null,
      );
    if (buf) this.vecSet(info.lastInsertRowid, buf);
    this.regenerateMarkdown(scope, item.layer);
    return {
      id,
      scope,
      layer: item.layer,
      text: item.text,
      origin,
      state,
      ...(state === "derived" && sourceThreadId
        ? { sourceThreadId, sessionId: sourceThreadId }
        : {}),
      updatedAt,
      ...(item.meta ? { meta: item.meta } : {}),
    };
  }

  async edit(id: string, patch: Partial<Pick<MemoryItem, "text" | "meta">>): Promise<MemoryItem> {
    const row = this.db
      .prepare(`SELECT rowid, * FROM memory_items WHERE id = ?`)
      .get(id) as unknown as Row | undefined;
    if (!row) throw new Error(`memory item not found: ${id}`);
    const text = patch.text ?? row.text;
    const updatedAt = new Date().toISOString();
    const emb = patch.text ? await this.embedOne(text) : row.embedding;
    const buf = emb instanceof Float32Array ? Buffer.from(emb.buffer) : emb;
    const meta = patch.meta !== undefined ? JSON.stringify(patch.meta) : row.meta;
    this.db
      .prepare(
        `UPDATE memory_items SET text = ?, embedding = ?, updated_at = ?, meta = ? WHERE id = ?`,
      )
      .run(text, buf, updatedAt, meta, id);
    if (patch.text) this.vecSet(row.rowid, buf); // 文本变了才会重嵌 → 同步向量
    this.regenerateMarkdown(row.scope, row.layer);
    return this.toItem({ ...row, text, updated_at: updatedAt, meta });
  }

  async promote(id: string, opts: { promotedBy?: "user" | "agent" } = {}): Promise<MemoryItem> {
    const row = this.db
      .prepare(`SELECT rowid, * FROM memory_items WHERE id = ?`)
      .get(id) as unknown as Row | undefined;
    if (!row) throw new Error(`memory item not found: ${id}`);
    if (row.lifecycle_state === "curated") return this.toItem(row);
    const promotedAt = new Date().toISOString();
    const previousMeta = row.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : {};
    const sourceThreadId = row.source_thread_id ?? row.session_id;
    const meta = JSON.stringify({
      ...previousMeta,
      promotedAt,
      promotedBy: opts.promotedBy ?? "user",
      ...(sourceThreadId ? { promotedFromSourceThreadId: sourceThreadId } : {}),
    });
    this.db
      .prepare(
        `UPDATE memory_items
         SET lifecycle_state = 'curated', source_thread_id = NULL, session_id = NULL, updated_at = ?, meta = ?
         WHERE id = ?`,
      )
      .run(promotedAt, meta, id);
    this.regenerateMarkdown(row.scope, row.layer);
    return this.toItem({
      ...row,
      lifecycle_state: "curated",
      source_thread_id: null,
      session_id: null,
      updated_at: promotedAt,
      meta,
    });
  }

  async list(filter?: {
    scope?: string;
    layer?: MemoryLayer;
    sessionId?: string;
  }): Promise<MemoryItem[]> {
    let sql = `SELECT * FROM memory_items`;
    const where: string[] = [];
    const params: (string | null)[] = [];
    if (filter?.scope) {
      where.push("scope = ?");
      params.push(filter.scope);
    }
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
    const row = this.db
      .prepare(`SELECT rowid, scope, layer FROM memory_items WHERE id = ?`)
      .get(id) as unknown as
      | { rowid: number | bigint; scope: string; layer: MemoryLayer }
      | undefined;
    this.db.prepare(`DELETE FROM memory_items WHERE id = ?`).run(id);
    if (row) {
      this.vecSet(row.rowid, null);
      this.regenerateMarkdown(row.scope, row.layer);
    }
  }

  /** 删除某 Source Conversation 仍拥有的 derived Extracted Facts。返回删除条数。 */
  async deleteBySession(sessionId: string): Promise<number> {
    const rows = this.db
      .prepare(
        `SELECT rowid, scope, layer FROM memory_items
         WHERE source_thread_id = ? AND lifecycle_state = 'derived'`,
      )
      .all(sessionId) as unknown as { rowid: number | bigint; scope: string; layer: MemoryLayer }[];
    if (rows.length === 0) return 0;
    this.db
      .prepare(
        `DELETE FROM memory_items WHERE source_thread_id = ? AND lifecycle_state = 'derived'`,
      )
      .run(sessionId);
    for (const r of rows) this.vecSet(r.rowid, null);
    for (const sl of uniqueScopeLayers(rows)) this.regenerateMarkdown(sl.scope, sl.layer);
    return rows.length;
  }

  /** 删除某作用域全部记忆（删除工作区时清其私有池）。返回删除条数。 */
  async deleteByScope(scope: string): Promise<number> {
    const rows = this.db
      .prepare(`SELECT rowid, layer FROM memory_items WHERE scope = ?`)
      .all(scope) as unknown as { rowid: number | bigint; layer: MemoryLayer }[];
    if (rows.length === 0) return 0;
    this.db.prepare(`DELETE FROM memory_items WHERE scope = ?`).run(scope);
    for (const r of rows) this.vecSet(r.rowid, null);
    for (const layer of new Set(rows.map((r) => r.layer))) this.regenerateMarkdown(scope, layer);
    return rows.length;
  }

  async recall(q: RecallQuery): Promise<MemoryItem[]> {
    const topK = q.topK ?? 6;
    const minScore = q.minScore ?? 0;
    const scope = q.scope ?? GLOBAL_SCOPE;
    const layers = q.layers?.length ? q.layers : layersForScope(scope);
    const placeholders = layers.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT rowid, * FROM memory_items WHERE scope = ? AND layer IN (${placeholders})`)
      .all(scope, ...layers) as unknown as Row[];

    const queryEmb = await this.embedOne(q.query);
    // 语义分一律走 sqlite-vec（全库 KNN，再按本作用域 rowid 取分）；无 embedding → 纯词法。
    const semByRowid = queryEmb ? (this.vec?.knn(queryEmb) ?? null) : null;

    const scored = rows.map((r) => {
      const lex = lexicalScore(q.query, r.text);
      const sem = semByRowid?.get(String(r.rowid));
      const score = sem != null ? 0.75 * sem + 0.25 * lex : lex;
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
    const rows = this.db
      .prepare(`SELECT rowid, id, text FROM memory_items ${where}`)
      .all() as unknown as {
      rowid: number | bigint;
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
          const buf = Buffer.from(Float32Array.from(v).buffer);
          update.run(buf, r.id);
          this.vecSet(r.rowid, buf);
          done++;
        }
      });
    }
    return done;
  }

  /**
   * 记忆抽取（注入 extractor 时）：把持久事实写入对应作用域，带去重 + 来源 sessionId。
   * scope 缺省 = global（对话池）；工作区传 ws:<id>。会话历史本身由 ConversationRepo 完整存档。
   */
  async observe(input: {
    messages: unknown[];
    sessionId: string;
    scope?: string;
    model?: string;
  }): Promise<void> {
    if (!this.extract) return;
    const msgs = input.messages as { role: string; content: unknown }[];
    await this.extractFacts(msgs, input.sessionId, input.scope ?? GLOBAL_SCOPE, input.model);
  }

  /** LLM 抽取持久事实并去重写入指定作用域（带来源 sessionId；失败不影响主流程）。 */
  private async extractFacts(
    messages: { role: string; content: unknown }[],
    sessionId: string,
    scope: string,
    model?: string,
  ): Promise<void> {
    if (!this.extract) return;
    const layers = layersForScope(scope);
    try {
      const existing = this.scopeFacts(scope, layers);
      const facts = await this.extract({
        messages,
        existing,
        layers,
        scope,
        ...(model ? { model } : {}),
      });
      for (const f of facts) {
        const text = f.text.trim();
        if (!text || !layers.includes(f.layer)) continue; // 作用域外的层一律忽略
        if (this.isDuplicateFact(f.layer, text, existing)) continue;
        await this.write({
          scope,
          layer: f.layer,
          text,
          origin: "extracted",
          state: "derived",
          sourceThreadId: sessionId,
        });
        existing.push({ layer: f.layer, text }); // 同批内也去重
      }
    } catch {
      /* 抽取失败不影响主流程 */
    }
  }

  /** 读取某作用域（指定层）的已有事实，供抽取去重。 */
  private scopeFacts(scope: string, layers: readonly MemoryLayer[]): ExtractedFact[] {
    const placeholders = layers.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT layer, text FROM memory_items WHERE scope = ? AND layer IN (${placeholders})`,
      )
      .all(scope, ...layers) as unknown as { layer: MemoryLayer; text: string }[];
    return rows.map((r) => ({ layer: r.layer, text: r.text }));
  }

  /** 候选事实是否与同层已有事实词法高度重叠（双向取大者，>= 阈值视为重复）。 */
  private isDuplicateFact(layer: MemoryLayer, text: string, existing: ExtractedFact[]): boolean {
    for (const e of existing) {
      if (e.layer !== layer) continue;
      const sim = Math.max(lexicalScore(text, e.text), lexicalScore(e.text, text));
      if (sim >= FACT_DEDUP_THRESHOLD) return true;
    }
    return false;
  }

  /** 仅全局作用域生成 markdown 镜像；工作区记忆为 DB-only。 */
  private regenerateMarkdown(scope: string, layer: MemoryLayer): void {
    if (scope !== GLOBAL_SCOPE) return;
    const file = LAYER_FILE[layer as (typeof GLOBAL_LAYERS)[number]];
    if (!file) return;
    try {
      const rows = this.db
        .prepare(`SELECT * FROM memory_items WHERE scope = ? AND layer = ? ORDER BY updated_at`)
        .all(GLOBAL_SCOPE, layer) as unknown as Row[];
      fs.writeFileSync(path.join(this.dir, file), renderLayer(layer, rows));
    } catch {
      /* markdown 镜像失败不影响主流程 */
    }
  }

  /**
   * 从全局 markdown 回灌索引（markdown 为真相源；仅全局作用域）。解析 `- 文本 <!-- id -->`：
   * 已有 id 文本变化 → 更新+重嵌；无 id 新行 → 新建；文件中消失的 id → 删除。
   * 幂等：无变化则不写库、不重生成（避免 watcher 自激）。
   */
  async syncFromMarkdown(layer: MemoryLayer): Promise<boolean> {
    const file = LAYER_FILE[layer as (typeof GLOBAL_LAYERS)[number]];
    if (!file) return false;
    let content: string;
    try {
      content = fs.readFileSync(path.join(this.dir, file), "utf8");
    } catch {
      return false; // 文件不存在 → 跳过
    }
    const entries = parseLayerMarkdown(content);
    const rows = this.db
      .prepare(
        `SELECT rowid, * FROM memory_items WHERE scope = ? AND layer = ? ORDER BY updated_at`,
      )
      .all(GLOBAL_SCOPE, layer) as unknown as Row[];
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
          const buf = emb ? Buffer.from(emb.buffer) : null;
          this.db
            .prepare(`UPDATE memory_items SET text = ?, embedding = ?, updated_at = ? WHERE id = ?`)
            .run(e.text, buf, now, e.id);
          this.vecSet(row.rowid, buf);
          changed = true;
        }
      } else if (e.text.trim()) {
        // 新行（用户手工添加，无 id）→ 写入全局作用域
        const id = randomUUID();
        const emb = await this.embedOne(e.text);
        const buf = emb ? Buffer.from(emb.buffer) : null;
        const info = this.db
          .prepare(
            `INSERT INTO memory_items
               (id, scope, layer, session_id, origin, lifecycle_state, source_thread_id, text, embedding, updated_at, meta)
             VALUES (?, ?, ?, NULL, 'imported', 'curated', NULL, ?, ?, ?, NULL)`,
          )
          .run(id, GLOBAL_SCOPE, layer, e.text, buf, now);
        if (buf) this.vecSet(info.lastInsertRowid, buf);
        changed = true;
      }
    }
    for (const r of rows) {
      if (!seenIds.has(r.id)) {
        this.db.prepare(`DELETE FROM memory_items WHERE id = ?`).run(r.id);
        this.vecSet(r.rowid, null);
        changed = true;
      }
    }
    if (changed) this.regenerateMarkdown(GLOBAL_SCOPE, layer);
    return changed;
  }

  /** 监听全局 markdown 目录，用户手工编辑后自动回灌索引（去抖）。返回停止函数。 */
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
          const layer = (Object.keys(LAYER_FILE) as (typeof GLOBAL_LAYERS)[number][]).find(
            (l) => LAYER_FILE[l] === fn,
          );
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

/** 去重 (scope,layer) 组合。 */
function uniqueScopeLayers(
  rows: { scope: string; layer: MemoryLayer }[],
): { scope: string; layer: MemoryLayer }[] {
  const seen = new Set<string>();
  const out: { scope: string; layer: MemoryLayer }[] = [];
  for (const r of rows) {
    const key = `${r.scope} ${r.layer}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ scope: r.scope, layer: r.layer });
  }
  return out;
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
