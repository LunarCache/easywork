import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type * as NodeSqlite from "node:sqlite";
import type {
  ApprovalMode,
  ChannelKind,
  ContentPart,
  ConversationRepo,
  MessageSearchHit,
  Project,
  Role,
  StoredMessage,
  Thread,
  ToolCall,
  ToolResult,
  TurnArtifact,
} from "@ew/shared";
import { messageText } from "@ew/shared";

// node:sqlite 通过 createRequire 运行时加载（避免打包器静态解析这个较新的内置模块）。
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof NodeSqlite;
type SqliteDB = InstanceType<typeof NodeSqlite.DatabaseSync>;

interface ProjectRow {
  id: string;
  name: string;
  instructions: string | null;
  workspace_dir: string | null;
  approval_mode: string | null;
  created_at: string;
  updated_at: string | null;
}

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
  artifacts: string | null;
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
        id TEXT PRIMARY KEY, name TEXT NOT NULL, instructions TEXT, created_at TEXT NOT NULL,
        workspace_dir TEXT, approval_mode TEXT, updated_at TEXT
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
        artifacts TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_msg_thread ON messages(thread_id, seq);
      -- 全文搜索（参考 Hermes session_search）。用 trigram 分词：对中英文都做子串匹配（≥3 字符）。
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        text, message_id UNINDEXED, thread_id UNINDEXED, tokenize='trigram'
      );
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
    // 老库平滑升级：projects 表补列（node:sqlite 无 ADD COLUMN IF NOT EXISTS）。
    const cols = new Set(
      (this.db.prepare(`PRAGMA table_info(projects)`).all() as unknown as { name: string }[]).map(
        (c) => c.name,
      ),
    );
    for (const [name, ddl] of [
      ["workspace_dir", "ALTER TABLE projects ADD COLUMN workspace_dir TEXT"],
      ["approval_mode", "ALTER TABLE projects ADD COLUMN approval_mode TEXT"],
      ["updated_at", "ALTER TABLE projects ADD COLUMN updated_at TEXT"],
    ] as const) {
      if (!cols.has(name)) this.db.exec(ddl);
    }
    const messageCols = new Set(
      (this.db.prepare(`PRAGMA table_info(messages)`).all() as unknown as { name: string }[]).map((c) => c.name),
    );
    if (!messageCols.has("artifacts")) this.db.exec("ALTER TABLE messages ADD COLUMN artifacts TEXT");
  }

  private rowToProject(r: ProjectRow): Project {
    return {
      id: r.id,
      name: r.name,
      ...(r.instructions ? { instructions: r.instructions } : {}),
      ...(r.workspace_dir ? { workspaceDir: r.workspace_dir } : {}),
      ...(r.approval_mode ? { approvalMode: r.approval_mode as ApprovalMode } : {}),
      createdAt: r.created_at,
      ...(r.updated_at ? { updatedAt: r.updated_at } : {}),
    };
  }

  createProject(p: Partial<Project> & { name: string }): Project {
    const now = new Date().toISOString();
    const project: Project = {
      id: p.id ?? randomUUID(),
      name: p.name,
      ...(p.instructions ? { instructions: p.instructions } : {}),
      ...(p.workspaceDir ? { workspaceDir: p.workspaceDir } : {}),
      approvalMode: p.approvalMode ?? "approve-each",
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO projects (id, name, instructions, workspace_dir, approval_mode, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        project.id,
        project.name,
        project.instructions ?? null,
        project.workspaceDir ?? null,
        project.approvalMode ?? null,
        project.createdAt,
        project.updatedAt ?? null,
      );
    return project;
  }

  getProject(id: string): Project | null {
    const r = this.db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as unknown as
      | ProjectRow
      | undefined;
    return r ? this.rowToProject(r) : null;
  }

  listProjects(): Project[] {
    const rows = this.db
      .prepare(`SELECT * FROM projects ORDER BY COALESCE(updated_at, created_at) DESC`)
      .all() as unknown as ProjectRow[];
    return rows.map((r) => this.rowToProject(r));
  }

  updateProject(
    id: string,
    patch: Partial<Pick<Project, "name" | "instructions" | "workspaceDir" | "approvalMode">>,
  ): Project {
    const cur = this.getProject(id);
    if (!cur) throw new Error(`project not found: ${id}`);
    const next: Project = {
      ...cur,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.instructions !== undefined ? { instructions: patch.instructions } : {}),
      ...(patch.workspaceDir !== undefined ? { workspaceDir: patch.workspaceDir } : {}),
      ...(patch.approvalMode !== undefined ? { approvalMode: patch.approvalMode } : {}),
      updatedAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `UPDATE projects SET name = ?, instructions = ?, workspace_dir = ?, approval_mode = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        next.name,
        next.instructions ?? null,
        next.workspaceDir ?? null,
        next.approvalMode ?? null,
        next.updatedAt ?? null,
        id,
      );
    return next;
  }

  deleteProject(id: string): void {
    // 解除其下 thread 的关联，不删 thread。
    this.db.prepare(`UPDATE threads SET project_id = NULL WHERE project_id = ?`).run(id);
    this.db.prepare(`DELETE FROM projects WHERE id = ?`).run(id);
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
        `INSERT INTO messages (id, thread_id, role, seq, parts, tool_calls, tool_results, artifacts, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        m.id,
        m.threadId,
        m.role,
        m.seq,
        JSON.stringify(m.parts),
        m.toolCalls ? JSON.stringify(m.toolCalls) : null,
        m.toolResults ? JSON.stringify(m.toolResults) : null,
        m.artifacts ? JSON.stringify(m.artifacts) : null,
        m.createdAt,
      );
    this.db.prepare(`UPDATE threads SET updated_at = ? WHERE id = ?`).run(m.createdAt, m.threadId);
    const ftsText = searchableText(m);
    if (ftsText) {
      this.db
        .prepare(`INSERT INTO messages_fts (text, message_id, thread_id) VALUES (?, ?, ?)`)
        .run(ftsText, m.id, m.threadId);
    }
  }

  searchMessages(query: string, opts?: { limit?: number; threadId?: string }): MessageSearchHit[] {
    const q = query.trim();
    if (!q) return [];
    const limit = opts?.limit ?? 10;
    // ≥3 字符走 FTS5 trigram（bm25 排序 + snippet 高亮）；更短（如中文 2 字词）走 LIKE 子串回退。
    return q.length >= 3 ? this.searchFts(q, limit, opts?.threadId) : this.searchLike(q, limit, opts?.threadId);
  }

  private searchFts(q: string, limit: number, threadId?: string): MessageSearchHit[] {
    const matchExpr = `"${q.replace(/"/g, '""')}"`; // 整串作字面量，避免 FTS 语法字符干扰
    const params: (string | number)[] = [matchExpr];
    let where = `messages_fts MATCH ?`;
    if (threadId) {
      where += ` AND m.thread_id = ?`;
      params.push(threadId);
    }
    params.push(limit);
    const rows = this.db
      .prepare(
        `SELECT m.id AS mid, m.thread_id AS tid, t.title AS title, m.role AS role,
                m.seq AS seq, m.created_at AS created_at,
                snippet(messages_fts, 0, '[', ']', '…', 16) AS snip
         FROM messages_fts
         JOIN messages m ON m.id = messages_fts.message_id
         JOIN threads t ON t.id = m.thread_id
         WHERE ${where}
         ORDER BY bm25(messages_fts)
         LIMIT ?`,
      )
      .all(...params) as unknown as FtsRow[];
    return rows.map(ftsRowToHit);
  }

  private searchLike(q: string, limit: number, threadId?: string): MessageSearchHit[] {
    const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const params: (string | number)[] = [pattern];
    let where = `messages_fts.text LIKE ? ESCAPE '\\'`;
    if (threadId) {
      where += ` AND m.thread_id = ?`;
      params.push(threadId);
    }
    params.push(limit);
    const rows = this.db
      .prepare(
        `SELECT m.id AS mid, m.thread_id AS tid, t.title AS title, m.role AS role,
                m.seq AS seq, m.created_at AS created_at, messages_fts.text AS snip
         FROM messages_fts
         JOIN messages m ON m.id = messages_fts.message_id
         JOIN threads t ON t.id = m.thread_id
         WHERE ${where}
         ORDER BY m.created_at DESC
         LIMIT ?`,
      )
      .all(...params) as unknown as FtsRow[];
    return rows.map((r) => ftsRowToHit({ ...r, snip: manualSnippet(r.snip, q) }));
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
      ...(r.artifacts ? { artifacts: JSON.parse(r.artifacts) as TurnArtifact[] } : {}),
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
    this.db.prepare(`DELETE FROM messages_fts WHERE thread_id = ?`).run(id);
    this.db.prepare(`DELETE FROM threads WHERE id = ?`).run(id);
    this.db.prepare(`DELETE FROM channel_sessions WHERE thread_id = ?`).run(id);
  }

  close(): void {
    this.db.close();
  }
}

interface FtsRow {
  mid: string;
  tid: string;
  title: string;
  role: string;
  seq: number;
  created_at: string;
  snip: string;
}

function ftsRowToHit(r: FtsRow): MessageSearchHit {
  return {
    threadId: r.tid,
    threadTitle: r.title,
    messageId: r.mid,
    role: r.role as Role,
    seq: r.seq,
    snippet: r.snip,
    createdAt: r.created_at,
  };
}

/** LIKE 回退路径用：在命中处截取窗口并用 [ ] 高亮（FTS snippet() 仅 MATCH 可用）。 */
function manualSnippet(text: string, q: string): string {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text.slice(0, 60);
  const start = Math.max(0, i - 24);
  const end = Math.min(text.length, i + q.length + 24);
  return `${start > 0 ? "…" : ""}${text.slice(start, i)}[${text.slice(i, i + q.length)}]${text.slice(i + q.length, end)}${end < text.length ? "…" : ""}`;
}

/** 构造一条消息的可搜索文本：正文 + 工具名/参数 + 工具结果文本。 */
function searchableText(m: StoredMessage): string {
  const parts: string[] = [];
  const body = messageText(m.parts);
  if (body.trim()) parts.push(body);
  for (const c of m.toolCalls ?? []) {
    parts.push(c.name);
    if (c.arguments) parts.push(c.arguments);
  }
  for (const r of m.toolResults ?? []) {
    const t = messageText(r.content);
    if (t.trim()) parts.push(t);
  }
  return parts.join("\n").trim();
}
