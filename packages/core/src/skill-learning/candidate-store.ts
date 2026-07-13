import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import type * as NodeSqlite from "node:sqlite";
import {
  LearnedSkillSchema,
  SkillCandidateSchema,
  SkillSnapshotSchema,
  type LearnedSkill,
  type SkillCandidate,
  type SkillCandidateStatus,
  type SkillSnapshot,
} from "@ew/shared";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof NodeSqlite;
type SqliteDB = InstanceType<typeof NodeSqlite.DatabaseSync>;

export class SkillCandidateStore {
  private readonly db: SqliteDB;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS skill_candidates (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        scope TEXT NOT NULL,
        workspace_id TEXT,
        updated_at TEXT NOT NULL,
        data_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_skill_candidates_status ON skill_candidates(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_skill_candidates_workspace ON skill_candidates(workspace_id);
      CREATE TABLE IF NOT EXISTS skill_learning_state (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS learned_skills (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        state TEXT NOT NULL,
        scope TEXT NOT NULL,
        workspace_id TEXT,
        data_json TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_learned_skill_scope_slug ON learned_skills(scope, COALESCE(workspace_id, ''), slug);
      CREATE TABLE IF NOT EXISTS skill_snapshots (
        id TEXT PRIMARY KEY,
        learned_skill_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        data_json TEXT NOT NULL
      );
    `);
  }

  put(candidate: SkillCandidate): SkillCandidate {
    const parsed = SkillCandidateSchema.parse(candidate);
    this.db.prepare(`
      INSERT INTO skill_candidates (id, status, scope, workspace_id, updated_at, data_json)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        scope = excluded.scope,
        workspace_id = excluded.workspace_id,
        updated_at = excluded.updated_at,
        data_json = excluded.data_json
    `).run(
      parsed.id,
      parsed.status,
      parsed.scope,
      parsed.workspaceId ?? null,
      parsed.updatedAt,
      JSON.stringify(parsed),
    );
    return parsed;
  }

  get(id: string): SkillCandidate | null {
    const row = this.db.prepare(`SELECT data_json FROM skill_candidates WHERE id = ?`).get(id) as
      | { data_json: string }
      | undefined;
    return row ? SkillCandidateSchema.parse(JSON.parse(row.data_json)) : null;
  }

  list(filter: { status?: SkillCandidateStatus; workspaceId?: string } = {}): SkillCandidate[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.status) {
      where.push("status = ?");
      params.push(filter.status);
    }
    if (filter.workspaceId) {
      where.push("workspace_id = ?");
      params.push(filter.workspaceId);
    }
    const rows = this.db
      .prepare(`SELECT data_json FROM skill_candidates ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC`)
      .all(...params) as unknown as { data_json: string }[];
    return rows.map((row) => SkillCandidateSchema.parse(JSON.parse(row.data_json)));
  }

  delete(id: string): void {
    this.db.prepare(`DELETE FROM skill_candidates WHERE id = ?`).run(id);
  }

  removeSource(threadId: string): { updated: number; deleted: number } {
    let updated = 0;
    let deleted = 0;
    for (const candidate of this.list()) {
      if (!candidate.sourceThreadIds.includes(threadId)) continue;
      const sourceThreadIds = candidate.sourceThreadIds.filter((id) => id !== threadId);
      if (sourceThreadIds.length === 0 && candidate.status !== "approved") {
        this.delete(candidate.id);
        deleted++;
        continue;
      }
      const now = new Date().toISOString();
      this.put({
        ...candidate,
        sourceThreadIds,
        evidence: candidate.evidence.filter((entry) => entry.sourceThreadId !== threadId),
        updatedAt: now,
      });
      updated++;
    }
    return { updated, deleted };
  }

  deleteWorkspace(workspaceId: string): number {
    const result = this.db.prepare(`DELETE FROM skill_candidates WHERE workspace_id = ?`).run(workspaceId);
    return Number(result.changes);
  }

  getState<T>(key: string, fallback: T): T {
    const row = this.db.prepare(`SELECT value_json FROM skill_learning_state WHERE key = ?`).get(key) as
      | { value_json: string }
      | undefined;
    if (!row) return fallback;
    try {
      return JSON.parse(row.value_json) as T;
    } catch {
      return fallback;
    }
  }

  setState(key: string, value: unknown): void {
    this.db.prepare(`
      INSERT INTO skill_learning_state (key, value_json) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
    `).run(key, JSON.stringify(value));
  }

  putLearned(skill: LearnedSkill): LearnedSkill {
    const parsed = LearnedSkillSchema.parse(skill);
    this.db.prepare(`
      INSERT INTO learned_skills (id, slug, state, scope, workspace_id, data_json)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET slug=excluded.slug, state=excluded.state, scope=excluded.scope,
        workspace_id=excluded.workspace_id, data_json=excluded.data_json
    `).run(parsed.id, parsed.slug, parsed.state, parsed.scope, parsed.workspaceId ?? null, JSON.stringify(parsed));
    return parsed;
  }

  getLearned(id: string): LearnedSkill | null {
    const row = this.db.prepare(`SELECT data_json FROM learned_skills WHERE id = ?`).get(id) as
      | { data_json: string }
      | undefined;
    return row ? LearnedSkillSchema.parse(JSON.parse(row.data_json)) : null;
  }

  findLearnedByPath(skillPath: string): LearnedSkill | null {
    for (const skill of this.listLearned()) if (skill.path === skillPath) return skill;
    return null;
  }

  listLearned(): LearnedSkill[] {
    const rows = this.db.prepare(`SELECT data_json FROM learned_skills`).all() as unknown as { data_json: string }[];
    return rows.map((row) => LearnedSkillSchema.parse(JSON.parse(row.data_json)));
  }

  putSnapshot(snapshot: SkillSnapshot): SkillSnapshot {
    const parsed = SkillSnapshotSchema.parse(snapshot);
    this.db.prepare(`INSERT INTO skill_snapshots (id, learned_skill_id, created_at, data_json) VALUES (?, ?, ?, ?)`)
      .run(parsed.id, parsed.learnedSkillId, parsed.createdAt, JSON.stringify(parsed));
    return parsed;
  }

  getSnapshot(id: string): SkillSnapshot | null {
    const row = this.db.prepare(`SELECT data_json FROM skill_snapshots WHERE id = ?`).get(id) as
      | { data_json: string }
      | undefined;
    return row ? SkillSnapshotSchema.parse(JSON.parse(row.data_json)) : null;
  }

  listSnapshots(learnedSkillId?: string): SkillSnapshot[] {
    const rows = learnedSkillId
      ? this.db.prepare(`SELECT data_json FROM skill_snapshots WHERE learned_skill_id = ? ORDER BY created_at DESC`).all(learnedSkillId)
      : this.db.prepare(`SELECT data_json FROM skill_snapshots ORDER BY created_at DESC`).all();
    return (rows as unknown as { data_json: string }[]).map((row) => SkillSnapshotSchema.parse(JSON.parse(row.data_json)));
  }

  close(): void {
    this.db.close();
  }
}
