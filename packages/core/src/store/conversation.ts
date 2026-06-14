import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type * as NodeSqlite from "node:sqlite";
import type {
  ChannelKind,
  ContentPart,
  ConversationRepo,
  Role,
  StoredMessage,
  Thread,
  ToolCall,
  ToolResult,
} from "@ew/shared";

// node:sqlite 通过 createRequire 运行时加载（避免打包器静态解析这个较新的内置模块）。
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof NodeSqlite;
type SqliteDB = InstanceType<typeof NodeSqlite.DatabaseSync>;

interface ThreadRow {
  id: string;
  project_id: string | null;
  title: string;
  channel_kind: string | null;
  channel_id: string | null;
  system_prompt: string | null;
  model_id: string;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  thread_id: string;
  role: string;
  seq: number;
  parts: string;
  tool_calls: string | null;
  tool_results: string | null;
  created_at: string;
}

/** SQLite 实现的会话仓库。跨渠道同一大脑：channel_sessions 把渠道身份映射到 thread。 */
export class SqliteConversationRepo implements ConversationRepo {
  private readonly db: SqliteDB;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, instructions TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        title TEXT NOT NULL,
        channel_kind TEXT,
        channel_id TEXT,
        system_prompt TEXT,
        model_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        role TEXT NOT NULL,
        seq INTEGER NOT NULL,
        parts TEXT NOT NULL,
        tool_calls TEXT,
        tool_results TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_msg_thread ON messages(thread_id, seq);
      CREATE TABLE IF NOT EXISTS channel_sessions (
        channel_kind TEXT NOT NULL,
        channel_user_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        PRIMARY KEY (channel_kind, channel_user_id)
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  /** 通用 KV 设置（持久化 provider/MCP 等配置）。 */
  getSetting(key: string): string | null {
    const r = this.db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as unknown as
      | { value: string }
      | undefined;
    return r ? r.value : null;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).run(key, value);
  }

  deleteSetting(key: string): void {
    this.db.prepare(`DELETE FROM settings WHERE key = ?`).run(key);
  }

  private rowToThread(r: ThreadRow): Thread {
    return {
      id: r.id,
      ...(r.project_id ? { projectId: r.project_id } : {}),
      title: r.title,
      ...(r.channel_kind ? { channel: { kind: r.channel_kind as ChannelKind, channelId: r.channel_id ?? "" } } : {}),
      ...(r.system_prompt ? { systemPrompt: r.system_prompt } : {}),
      modelId: r.model_id,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  createThread(t: Partial<Thread>): Thread {
    const now = new Date().toISOString();
    const thread: Thread = {
      id: t.id ?? randomUUID(),
      ...(t.projectId ? { projectId: t.projectId } : {}),
      title: t.title ?? "新会话",
      ...(t.channel ? { channel: t.channel } : {}),
      ...(t.systemPrompt ? { systemPrompt: t.systemPrompt } : {}),
      modelId: t.modelId ?? "",
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO threads (id, project_id, title, channel_kind, channel_id, system_prompt, model_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        thread.id,
        thread.projectId ?? null,
        thread.title,
        thread.channel?.kind ?? null,
        thread.channel?.channelId ?? null,
        thread.systemPrompt ?? null,
        thread.modelId,
        thread.createdAt,
        thread.updatedAt,
      );
    return thread;
  }

  getThread(id: string): Thread | null {
    const r = this.db.prepare(`SELECT * FROM threads WHERE id = ?`).get(id) as unknown as ThreadRow | undefined;
    return r ? this.rowToThread(r) : null;
  }

  listThreads(filter?: { projectId?: string }): Thread[] {
    const rows = filter?.projectId
      ? (this.db.prepare(`SELECT * FROM threads WHERE project_id = ? ORDER BY updated_at DESC`).all(filter.projectId) as unknown as ThreadRow[])
      : (this.db.prepare(`SELECT * FROM threads ORDER BY updated_at DESC`).all() as unknown as ThreadRow[]);
    return rows.map((r) => this.rowToThread(r));
  }

  /** 下一个 seq（便于调用方无需自行计算）。 */
  nextSeq(threadId: string): number {
    const r = this.db.prepare(`SELECT MAX(seq) AS m FROM messages WHERE thread_id = ?`).get(threadId) as unknown as { m: number | null };
    return (r.m ?? -1) + 1;
  }

  appendMessage(m: StoredMessage): void {
    this.db
      .prepare(
        `INSERT INTO messages (id, thread_id, role, seq, parts, tool_calls, tool_results, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        m.id,
        m.threadId,
        m.role,
        m.seq,
        JSON.stringify(m.parts),
        m.toolCalls ? JSON.stringify(m.toolCalls) : null,
        m.toolResults ? JSON.stringify(m.toolResults) : null,
        m.createdAt,
      );
    this.db.prepare(`UPDATE threads SET updated_at = ? WHERE id = ?`).run(m.createdAt, m.threadId);
  }

  history(threadId: string, limit?: number): StoredMessage[] {
    const sql = limit
      ? `SELECT * FROM (SELECT * FROM messages WHERE thread_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC`
      : `SELECT * FROM messages WHERE thread_id = ? ORDER BY seq ASC`;
    const rows = (limit ? this.db.prepare(sql).all(threadId, limit) : this.db.prepare(sql).all(threadId)) as unknown as MessageRow[];
    return rows.map((r) => ({
      id: r.id,
      threadId: r.thread_id,
      role: r.role as Role,
      seq: r.seq,
      parts: JSON.parse(r.parts) as ContentPart[],
      ...(r.tool_calls ? { toolCalls: JSON.parse(r.tool_calls) as ToolCall[] } : {}),
      ...(r.tool_results ? { toolResults: JSON.parse(r.tool_results) as ToolResult[] } : {}),
      createdAt: r.created_at,
    }));
  }

  resolveThreadForChannel(
    kind: ChannelKind,
    channelUserId: string,
    opts?: { projectId?: string; modelId?: string },
  ): Thread {
    const map = this.db
      .prepare(`SELECT thread_id FROM channel_sessions WHERE channel_kind = ? AND channel_user_id = ?`)
      .get(kind, channelUserId) as unknown as { thread_id: string } | undefined;
    if (map) {
      const t = this.getThread(map.thread_id);
      if (t) return t;
    }
    const thread = this.createThread({
      title: `${kind}:${channelUserId}`,
      channel: { kind, channelId: channelUserId },
      ...(opts?.projectId ? { projectId: opts.projectId } : {}),
      ...(opts?.modelId ? { modelId: opts.modelId } : {}),
    });
    this.db
      .prepare(`INSERT OR REPLACE INTO channel_sessions (channel_kind, channel_user_id, thread_id) VALUES (?, ?, ?)`)
      .run(kind, channelUserId, thread.id);
    return thread;
  }

  deleteThread(id: string): void {
    this.db.prepare(`DELETE FROM messages WHERE thread_id = ?`).run(id);
    this.db.prepare(`DELETE FROM threads WHERE id = ?`).run(id);
    this.db.prepare(`DELETE FROM channel_sessions WHERE thread_id = ?`).run(id);
  }

  close(): void {
    this.db.close();
  }
}
