import type * as NodeSqlite from "node:sqlite";

type SqliteDB = InstanceType<typeof NodeSqlite.DatabaseSync>;

/** 调用方提供的「回填源」：(重)建表后逐条喂回 (rowid, 向量字节)。 */
export type VecRepopulate = (add: (rowid: number | bigint, buf: Buffer) => void) => void;

/**
 * sqlite-vec 向量索引（vec0 虚拟表，cosine 距离）的薄封装，供本地记忆使用。
 * 用法：DatabaseSync 须以 `{ allowExtension: true }` 创建；构造后调用 `load(path)`（失败抛出——
 * sqlite-vec 是必备依赖，加载失败说明打包缺二进制，应当显式暴露而非静默降级）。
 * 真相源仍是各自表里的 embedding blob；本索引只是查询加速结构，随写/改/删同步。
 *
 * 注意：vec0 的 rowid 必须用 BigInt 绑定（node:sqlite 传 number 会报「Only integers...」）。
 */
export class SqliteVecIndex {
  private ready = false;
  private dim = 0;
  private readonly metaTable: string;

  constructor(
    private readonly db: SqliteDB,
    private readonly table = "vec_items",
  ) {
    this.metaTable = `${this.table}_meta`;
  }

  get isReady(): boolean {
    return this.ready;
  }

  get dimension(): number {
    return this.dim;
  }

  /** 加载 sqlite-vec 可加载扩展并恢复已建表的维度。失败抛出（必备依赖，不静默降级）。 */
  load(extPath: string): void {
    this.db.enableLoadExtension(true);
    try {
      this.db.loadExtension(extPath);
    } finally {
      try {
        this.db.enableLoadExtension(false);
      } catch {
        /* 关闭扩展加载失败无害 */
      }
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS ${this.metaTable} (key TEXT PRIMARY KEY, value TEXT)`);
    const row = this.db.prepare(`SELECT value FROM ${this.metaTable} WHERE key='dim'`).get() as
      | { value?: string }
      | undefined;
    if (row?.value) this.dim = Number(row.value) || 0;
    this.ready = true;
  }

  private tableExists(name: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM sqlite_master WHERE name = ?`).get(name);
  }

  /** 按维度（重）建 vec0 表；维度变化时 drop+重建并用 repopulate 回填。维度不变且已存在直接复用。 */
  ensureTable(dim: number, repopulate?: VecRepopulate): boolean {
    if (!this.ready || dim <= 0) return false;
    if (this.dim === dim && this.tableExists(this.table)) return true;
    this.db.exec(`DROP TABLE IF EXISTS ${this.table}`);
    this.db.exec(`CREATE VIRTUAL TABLE ${this.table} USING vec0(embedding float[${dim}] distance_metric=cosine)`);
    this.dim = dim;
    this.db
      .prepare(`INSERT INTO ${this.metaTable}(key,value) VALUES('dim',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
      .run(String(dim));
    if (repopulate) {
      const ins = this.db.prepare(`INSERT INTO ${this.table}(rowid, embedding) VALUES(?, ?)`);
      repopulate((rowid, buf) => {
        if (buf.byteLength / 4 === dim) ins.run(BigInt(rowid), buf);
      });
    }
    return true;
  }

  /** 同步一条向量（buf=null 删除）。维度变化时经 repopulate 回填其余条目。 */
  set(rowid: number | bigint | undefined, buf: Buffer | null, repopulate?: VecRepopulate): void {
    if (!this.ready || rowid == null) return;
    const id = BigInt(rowid);
    if (!buf) {
      if (this.tableExists(this.table)) this.db.prepare(`DELETE FROM ${this.table} WHERE rowid = ?`).run(id);
      return;
    }
    const dim = buf.byteLength / 4;
    if (!this.ensureTable(dim, repopulate) || dim !== this.dim) return;
    this.db.prepare(`DELETE FROM ${this.table} WHERE rowid = ?`).run(id);
    this.db.prepare(`INSERT INTO ${this.table}(rowid, embedding) VALUES(?, ?)`).run(id, buf);
  }

  /**
   * cosine KNN：返回 rowid(string) → 相似度（1 - cosine 距离）。k 取索引内向量总数（≤4096 即精确，
   * 调用方再按需筛选自己的分区；超大索引退为近似 top-4096）。
   * 维度不符 / 表不存在返回 null（调用方据此降级为纯词法）。
   */
  knn(queryEmb: Float32Array): Map<string, number> | null {
    if (!this.ready || this.dim !== queryEmb.length || !this.tableExists(this.table)) return null;
    const total = (this.db.prepare(`SELECT count(*) AS c FROM ${this.table}`).get() as { c: number }).c;
    const k = Math.min(Math.max(total, 1), 4096);
    const hits = this.db
      .prepare(`SELECT rowid, distance FROM ${this.table} WHERE embedding MATCH ? AND k = ${k}`)
      .all(Buffer.from(queryEmb.buffer)) as unknown as { rowid: number | bigint; distance: number }[];
    return new Map(hits.map((h) => [String(h.rowid), 1 - Number(h.distance)]));
  }
}
