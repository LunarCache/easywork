import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type * as NodeSqlite from "node:sqlite";
import { SqliteVecIndex } from "@ew/memory";
import { chunkText } from "./chunking.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof NodeSqlite;
type SqliteDB = InstanceType<typeof NodeSqlite.DatabaseSync>;

export type Embedder = (texts: string[]) => Promise<number[][]>;

export interface KbDoc {
  id: string;
  kbId: string;
  source: string;
  chunks: number;
  createdAt: string;
}

export interface RagHit {
  text: string;
  source: string;
  docId: string;
  chunkIndex: number;
  score: number;
}

interface ChunkRow {
  rowid?: number | bigint;
  id: string;
  kb_id: string;
  doc_id: string;
  source: string;
  chunk_index: number;
  text: string;
  embedding: Buffer | null;
}

function lexicalScore(query: string, text: string): number {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
  if (terms.length === 0) return 0;
  const hay = text.toLowerCase();
  let hits = 0;
  for (const t of terms) if (hay.includes(t)) hits++;
  return hits / terms.length;
}

/**
 * 文档知识库：分块 + 嵌入 + 混合检索（RRF 倒数排名融合，参考 Unsloth rag/retrieval.py）。
 * 语义分走 sqlite-vec（与记忆一致，已移除 JS 余弦 brute-force）；embedding 缺省/扩展无二进制时降级为纯词法。
 */
export class KnowledgeBaseStore {
  private readonly db: SqliteDB;
  private readonly embed?: Embedder;
  private readonly vec?: SqliteVecIndex;

  constructor(opts: { dbPath: string; embed?: Embedder; vecExtensionPath?: string }) {
    if (opts.dbPath !== ":memory:") fs.mkdirSync(path.dirname(opts.dbPath), { recursive: true });
    if (opts.embed) this.embed = opts.embed;
    this.db = opts.vecExtensionPath
      ? new DatabaseSync(opts.dbPath, { allowExtension: true })
      : new DatabaseSync(opts.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kb_docs (
        id TEXT PRIMARY KEY, kb_id TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS kb_chunks (
        id TEXT PRIMARY KEY,
        kb_id TEXT NOT NULL,
        doc_id TEXT NOT NULL,
        source TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        text TEXT NOT NULL,
        embedding BLOB
      );
      CREATE INDEX IF NOT EXISTS idx_kbchunk_kb ON kb_chunks(kb_id);
      CREATE INDEX IF NOT EXISTS idx_kbchunk_doc ON kb_chunks(doc_id);
    `);
    if (opts.vecExtensionPath) {
      this.vec = new SqliteVecIndex(this.db, "kb_vec");
      this.vec.load(opts.vecExtensionPath); // 失败抛出：sqlite-vec 是必备依赖
    }
  }

  /** 回填源：把 kb_chunks 里所有 embedding blob 喂回 vec 索引（维度变化重建时用）。 */
  private repopulateVec = (add: (rowid: number | bigint, buf: Buffer) => void): void => {
    const rows = this.db
      .prepare(`SELECT rowid, embedding FROM kb_chunks WHERE embedding IS NOT NULL`)
      .all() as unknown as { rowid: number | bigint; embedding: Buffer }[];
    for (const r of rows) add(r.rowid, r.embedding);
  };

  private async embedOne(text: string): Promise<Float32Array | null> {
    if (!this.embed) return null;
    try {
      const [v] = await this.embed([text]);
      return v ? Float32Array.from(v) : null;
    } catch {
      return null;
    }
  }

  /** 摄取一篇文档：分块 → 分批嵌入（带进度回调）→ 入库。返回 doc。 */
  async ingest(
    opts: { kbId?: string; source: string; text: string },
    onProgress?: (p: { done: number; total: number }) => void,
  ): Promise<KbDoc> {
    const kbId = opts.kbId ?? "default";
    const docId = randomUUID();
    const createdAt = new Date().toISOString();
    const chunks = chunkText(opts.text);
    onProgress?.({ done: 0, total: chunks.length });

    // 分批嵌入并逐批上报进度（嵌入是最慢的一步）。
    const vectors: (number[] | undefined)[] = new Array(chunks.length).fill(undefined);
    if (this.embed && chunks.length > 0) {
      const BATCH = 8;
      for (let i = 0; i < chunks.length; i += BATCH) {
        const slice = chunks.slice(i, i + BATCH);
        try {
          const vs = await this.embed(slice.map((c) => c.text));
          slice.forEach((_, j) => (vectors[i + j] = vs[j]));
        } catch {
          /* 该批嵌入失败 → 留 null（降级为词法） */
        }
        onProgress?.({ done: Math.min(i + BATCH, chunks.length), total: chunks.length });
      }
    } else {
      onProgress?.({ done: chunks.length, total: chunks.length });
    }

    const insert = this.db.prepare(
      `INSERT INTO kb_chunks (id, kb_id, doc_id, source, chunk_index, text, embedding) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    chunks.forEach((c, i) => {
      const v = vectors[i];
      const emb = v ? Buffer.from(Float32Array.from(v).buffer) : null;
      const info = insert.run(randomUUID(), kbId, docId, opts.source, c.index, c.text, emb);
      if (emb) this.vec?.set(info.lastInsertRowid, emb, this.repopulateVec);
    });
    this.db
      .prepare(`INSERT INTO kb_docs (id, kb_id, source, created_at) VALUES (?, ?, ?, ?)`)
      .run(docId, kbId, opts.source, createdAt);
    return { id: docId, kbId, source: opts.source, chunks: chunks.length, createdAt };
  }

  /** 列出文档；kbId 省略=全部集合。 */
  listDocs(kbId?: string): KbDoc[] {
    const sql = `SELECT d.id, d.kb_id, d.source, d.created_at, COUNT(c.id) AS n
         FROM kb_docs d LEFT JOIN kb_chunks c ON c.doc_id = d.id
         ${kbId ? "WHERE d.kb_id = ?" : ""} GROUP BY d.id ORDER BY d.created_at DESC`;
    const rows = (kbId ? this.db.prepare(sql).all(kbId) : this.db.prepare(sql).all()) as unknown as {
      id: string;
      kb_id: string;
      source: string;
      created_at: string;
      n: number;
    }[];
    return rows.map((r) => ({ id: r.id, kbId: r.kb_id, source: r.source, chunks: r.n, createdAt: r.created_at }));
  }

  /** 列出所有知识库集合及其规模。 */
  listKbs(): { kbId: string; docs: number; chunks: number }[] {
    const rows = this.db
      .prepare(
        `SELECT kb_id, COUNT(DISTINCT doc_id) AS docs, COUNT(*) AS chunks
         FROM kb_chunks GROUP BY kb_id ORDER BY kb_id`,
      )
      .all() as unknown as { kb_id: string; docs: number; chunks: number }[];
    return rows.map((r) => ({ kbId: r.kb_id, docs: r.docs, chunks: r.chunks }));
  }

  deleteDoc(docId: string): void {
    if (this.vec) {
      const rows = this.db
        .prepare(`SELECT rowid FROM kb_chunks WHERE doc_id = ?`)
        .all(docId) as unknown as { rowid: number | bigint }[];
      for (const r of rows) this.vec.set(r.rowid, null);
    }
    this.db.prepare(`DELETE FROM kb_chunks WHERE doc_id = ?`).run(docId);
    this.db.prepare(`DELETE FROM kb_docs WHERE id = ?`).run(docId);
  }

  /** 片段计数；kbId 省略=全部集合。 */
  count(kbId?: string): number {
    const r = (
      kbId
        ? this.db.prepare(`SELECT COUNT(*) AS n FROM kb_chunks WHERE kb_id = ?`).get(kbId)
        : this.db.prepare(`SELECT COUNT(*) AS n FROM kb_chunks`).get()
    ) as unknown as { n: number };
    return r.n;
  }

  /** 混合检索：dense（sqlite-vec cosine）+ lexical，RRF 融合。kbId 省略=跨全部集合。无 embedding 时退化为纯词法。 */
  async retrieve(query: string, opts: { kbId?: string; topK?: number; minScore?: number } = {}): Promise<RagHit[]> {
    const topK = opts.topK ?? 4;
    const rows = (
      opts.kbId
        ? this.db.prepare(`SELECT rowid, * FROM kb_chunks WHERE kb_id = ?`).all(opts.kbId)
        : this.db.prepare(`SELECT rowid, * FROM kb_chunks`).all()
    ) as unknown as ChunkRow[];
    if (rows.length === 0) return [];

    const queryEmb = await this.embedOne(query);
    // 语义分一律走 sqlite-vec（全库 KNN，再按本集合 rowid 取分）；无 embedding → 纯词法。
    const semByRowid = queryEmb ? (this.vec?.knn(queryEmb) ?? null) : null;
    const dense: { i: number; s: number }[] = [];
    const lex: { i: number; s: number }[] = [];
    rows.forEach((r, i) => {
      lex.push({ i, s: lexicalScore(query, r.text) });
      const sem = semByRowid?.get(String(r.rowid));
      if (sem != null) dense.push({ i, s: sem });
    });

    // RRF 融合：score = Σ 1/(k + rank)。k=60（常用）。
    const K = 60;
    const rrf = new Map<number, number>();
    const denseRanked = [...dense].sort((a, b) => b.s - a.s);
    const lexRanked = [...lex].sort((a, b) => b.s - a.s);
    denseRanked.forEach((d, rank) => rrf.set(d.i, (rrf.get(d.i) ?? 0) + 1 / (K + rank)));
    lexRanked.forEach((l, rank) => {
      if (l.s > 0) rrf.set(l.i, (rrf.get(l.i) ?? 0) + 1 / (K + rank));
    });
    // 相关度门槛：用 dense cosine（若有）否则 lexical。
    const denseScore = new Map(dense.map((d) => [d.i, d.s]));
    const lexScore = new Map(lex.map((l) => [l.i, l.s]));
    const minScore = opts.minScore;
    const fused = [...rrf.entries()]
      .map(([i, s]) => ({ i, rrf: s, rel: denseScore.get(i) ?? lexScore.get(i) ?? 0 }))
      .filter((x) => (minScore == null ? true : x.rel >= minScore))
      .sort((a, b) => b.rrf - a.rrf)
      .slice(0, topK);

    return fused.map((f) => {
      const r = rows[f.i]!;
      return { text: r.text, source: r.source, docId: r.doc_id, chunkIndex: r.chunk_index, score: f.rel };
    });
  }

  close(): void {
    this.db.close();
  }
}
