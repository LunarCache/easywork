import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter, type SkillManager } from "@ew/skills";
import {
  SkillCandidateCreateSchema,
  type SkillCandidate,
  type SkillCandidateCreate,
  type LearnedSkill,
  type SkillSnapshot,
  type SkillValidationFinding,
  type SkillValidationReport,
} from "@ew/shared";
import type { SqliteConversationRepo } from "../store/conversation.js";
import type { SessionHost } from "../agent/session-host.js";
import { SkillCandidateStore } from "./candidate-store.js";

const SECRET_PATTERNS = [
  /\b(?:sk|ghp|xox[baprs])-[-_a-z0-9]{8,}\b/i,
  /\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*[^\s]{6,}/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];
const INJECTION_PATTERNS = [
  /ignore (?:all )?(?:previous|prior) instructions/i,
  /override (?:the )?(?:system|developer) (?:prompt|instructions)/i,
  /bypass (?:approval|permissions|policy)/i,
];
const INVISIBLE_UNICODE = /[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/;
const MAX_PACKAGE_FILES = 64;
const MAX_PACKAGE_BYTES = 256_000;
const EXFILTRATION_PATTERNS = [
  /\b(?:curl|wget|scp|nc|netcat)\b[^\n]*(?:\.ssh|\.env|credentials|private[_-]?key|keychain|\/etc\/passwd)/i,
  /\b(?:upload|send|post|exfiltrat\w*)\b[^\n]*(?:secret|credential|token|password|private key)/i,
];

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function contentHash(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function packageContentHash(skillMd: string, packageFiles: Record<string, string> = {}): string {
  const files = Object.fromEntries(
    Object.entries(packageFiles)
      .map(([name, content]) => [name.replace(/\\/g, "/"), content] as const)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  return contentHash(JSON.stringify({ skillMd, files }));
}

export interface SkillCandidateServiceDeps {
  store: SkillCandidateStore;
  skills: SkillManager;
  skillsDir: string;
  repo: SqliteConversationRepo;
  sessionHost: SessionHost;
  archiveDir: string;
  knownTools?: () => Iterable<string>;
}

export class SkillCandidateService {
  constructor(private readonly deps: SkillCandidateServiceDeps) {}

  validate(input: SkillCandidateCreate | SkillCandidate): SkillValidationReport {
    const findings: SkillValidationFinding[] = [];
    const slug = slugify(input.name);
    if (!slug || slug !== input.name) {
      findings.push({ code: "invalid-slug", severity: "error", message: "Skill name must be a collision-safe lowercase slug" });
    }
    if (input.scope === "workspace" && !input.workspaceId) {
      findings.push({ code: "workspace-required", severity: "error", message: "Workspace scope requires workspaceId" });
    }
    const knownTools = new Set(this.deps.knownTools?.() ?? []);
    for (const tool of input.requiredTools) {
      if (tool.startsWith("optional:") || knownTools.has(tool)) continue;
      findings.push({ code: "missing-tool", severity: "error", message: `Required tool is unavailable: ${tool}` });
    }
    let frontmatter: ReturnType<typeof parseFrontmatter>["data"] = {};
    try {
      frontmatter = parseFrontmatter(input.proposedSkillMd).data;
    } catch {
      findings.push({ code: "invalid-frontmatter", severity: "error", message: "SKILL.md frontmatter is invalid" });
    }
    if (!frontmatter.name || !frontmatter.description || !(frontmatter.whenToUse ?? frontmatter["when-to-use"])) {
      findings.push({ code: "invalid-frontmatter", severity: "error", message: "name, description, and whenToUse are required" });
    }
    if (frontmatter.name && frontmatter.name !== input.name) {
      findings.push({ code: "name-mismatch", severity: "error", message: "Frontmatter name must match the candidate slug" });
    }
    if (!/^## Verification\b/m.test(input.proposedSkillMd)) {
      findings.push({ code: "missing-verification", severity: "error", message: "Skill must include a Verification section" });
    }
    const allContent = [input.proposedSkillMd, ...Object.values(input.packageFiles ?? {})].join("\n");
    const packageEntries = Object.entries(input.packageFiles ?? {});
    const packageBytes = Buffer.byteLength(input.proposedSkillMd) + packageEntries.reduce((total, [, content]) => total + Buffer.byteLength(content), 0);
    if (packageEntries.length + 1 > MAX_PACKAGE_FILES || packageBytes > MAX_PACKAGE_BYTES) {
      findings.push({ code: "package-too-large", severity: "error", message: "Candidate package exceeds file-count or byte limits" });
    }
    if (SECRET_PATTERNS.some((pattern) => pattern.test(allContent))) {
      findings.push({ code: "secret", severity: "error", message: "Candidate contains a possible credential or secret" });
    }
    if (INJECTION_PATTERNS.some((pattern) => pattern.test(allContent))) {
      findings.push({ code: "instruction-injection", severity: "error", message: "Candidate attempts to override policy or instructions" });
    }
    if (INVISIBLE_UNICODE.test(allContent)) {
      findings.push({ code: "invisible-unicode", severity: "error", message: "Candidate contains invisible control characters" });
    }
    if (EXFILTRATION_PATTERNS.some((pattern) => pattern.test(allContent))) {
      findings.push({ code: "data-exfiltration", severity: "error", message: "Candidate contains possible data exfiltration instructions" });
    }
    if (/(?:^|[\s"'`(])\.\.[\\/][^\s"'`)]+/m.test(allContent)) {
      findings.push({ code: "path-escape", severity: "error", message: "Candidate content contains a parent-directory traversal" });
    }
    for (const file of Object.keys(input.packageFiles ?? {})) {
      if (file.includes("\\")) {
        findings.push({ code: "noncanonical-path", severity: "error", message: `Package paths must use '/': ${file}`, path: file });
      }
      if (path.isAbsolute(file) || file.split(/[\\/]/).includes("..") || file === "SKILL.md") {
        findings.push({ code: "path-escape", severity: "error", message: `Invalid package path: ${file}`, path: file });
      }
    }
    const referenced = [
      ...[...input.proposedSkillMd.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((match) => match[1]!),
      ...[...allContent.matchAll(/(?:^|[\s"'`(])((?:scripts|references|assets|templates)[\\/][a-zA-Z0-9._/-]+)/gm)].map((match) => match[1]!),
    ];
    for (const ref of referenced) {
      if (/^(?:https?:|#)/.test(ref)) continue;
      if (path.isAbsolute(ref) || ref.split(/[\\/]/).includes("..")) {
        findings.push({ code: "path-escape", severity: "error", message: `Reference escapes the package: ${ref}`, path: ref });
      } else if (ref !== "SKILL.md" && !(input.packageFiles && ref in input.packageFiles)) {
        findings.push({ code: "missing-reference", severity: "error", message: `Referenced file is missing: ${ref}`, path: ref });
      }
    }
    if (input.scope === "workspace" && input.workspaceId) {
      try {
        this.targetRoot(input as SkillCandidate);
      } catch (error) {
        findings.push({
          code: "workspace-path",
          severity: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return {
      valid: !findings.some((finding) => finding.severity === "error"),
      contentHash: packageContentHash(input.proposedSkillMd, input.packageFiles),
      findings,
      checkedAt: new Date().toISOString(),
    };
  }

  stage(raw: SkillCandidateCreate): SkillCandidate {
    const input = SkillCandidateCreateSchema.parse(raw);
    const validation = this.validate(input);
    if (!validation.valid) throw Object.assign(new Error("candidate_validation_failed"), { validation });
    const now = new Date().toISOString();
    const candidate: SkillCandidate = {
      ...input,
      id: crypto.randomUUID(),
      slug: slugify(input.name),
      status: "pending",
      validation,
      createdAt: now,
      updatedAt: now,
    };
    return this.deps.store.put(candidate);
  }

  list(): SkillCandidate[] {
    return this.deps.store.list();
  }

  get(id: string): SkillCandidate | null {
    return this.deps.store.get(id);
  }

  diff(id: string): string {
    const candidate = this.deps.store.get(id);
    if (!candidate) throw new Error("candidate_not_found");
    const base = candidate.baseSkillId ? this.deps.store.getLearned(candidate.baseSkillId) : null;
    const oldFiles = base ? this.readPackage(base.path) : {};
    const newFiles: Record<string, string> = { "SKILL.md": candidate.proposedSkillMd, ...(candidate.packageFiles ?? {}) };
    const names = [...new Set([...Object.keys(oldFiles), ...Object.keys(newFiles)])].sort();
    return names.flatMap((name) => {
      const oldText = oldFiles[name] ?? "";
      const newText = newFiles[name] ?? "";
      if (oldText === newText) return [];
      const oldLines = oldText ? oldText.replace(/\n$/, "").split("\n") : [];
      const newLines = newText ? newText.replace(/\n$/, "").split("\n") : [];
      return [[
        `--- ${name in oldFiles ? `a/${name}` : "/dev/null"}`,
        `+++ ${name in newFiles ? `b/${name}` : "/dev/null"}`,
        `@@ -${oldLines.length ? 1 : 0},${oldLines.length} +${newLines.length ? 1 : 0},${newLines.length} @@`,
        ...oldLines.map((line) => `-${line}`),
        ...newLines.map((line) => `+${line}`),
      ].join("\n")];
    }).join("\n\n");
  }

  revise(id: string, patch: Partial<Pick<SkillCandidateCreate, "description" | "triggerConditions" | "proposedSkillMd" | "packageFiles" | "reason">>): SkillCandidate {
    const current = this.requirePending(id);
    const nextInput = SkillCandidateCreateSchema.parse({ ...current, ...patch });
    return this.deps.store.put({
      ...current,
      description: nextInput.description,
      triggerConditions: nextInput.triggerConditions,
      proposedSkillMd: nextInput.proposedSkillMd,
      ...(nextInput.packageFiles ? { packageFiles: nextInput.packageFiles } : { packageFiles: undefined }),
      reason: nextInput.reason,
      validation: this.validate(nextInput),
      updatedAt: new Date().toISOString(),
    });
  }

  changeScope(id: string, scope: "global" | "workspace", workspaceId?: string): SkillCandidate {
    const current = this.requirePending(id);
    if (current.baseSkillId) throw new Error("candidate_patch_scope_locked");
    const next = { ...current, scope, ...(workspaceId ? { workspaceId } : { workspaceId: undefined }) };
    return this.deps.store.put({ ...next, validation: this.validate(next), updatedAt: new Date().toISOString() });
  }

  reject(id: string, reason?: string): SkillCandidate {
    const current = this.requirePending(id);
    return this.deps.store.put({
      ...current,
      status: "rejected",
      ...(reason ? { rejectionReason: reason } : {}),
      updatedAt: new Date().toISOString(),
    });
  }

  async approve(id: string): Promise<SkillCandidate> {
    const current = this.requirePending(id);
    const validation = this.validate(current);
    if (!validation.valid) throw Object.assign(new Error("candidate_validation_failed"), { validation });
    if (current.baseSkillId && current.baseContentHash) {
      const learned = this.deps.store.getLearned(current.baseSkillId);
      if (!learned) throw new Error("candidate_base_changed");
      if (
        learned.createdBy === "user" || learned.pinned || learned.slug !== current.slug ||
        learned.scope !== current.scope || learned.workspaceId !== current.workspaceId
      ) {
        throw new Error("candidate_base_not_managed");
      }
      const expectedTarget = this.confinedTarget(this.targetRoot(current), current.slug);
      if (path.resolve(expectedTarget) !== path.resolve(learned.path)) throw new Error("candidate_base_path_mismatch");
      const activeFiles = this.readPackage(learned.path);
      const activeSkillMd = activeFiles["SKILL.md"] ?? "";
      const activeResources = Object.fromEntries(Object.entries(activeFiles).filter(([name]) => name !== "SKILL.md"));
      if (packageContentHash(activeSkillMd, activeResources) !== current.baseContentHash) {
        throw new Error("candidate_base_changed");
      }
    }
    const root = this.targetRoot(current);
    const target = this.confinedTarget(root, current.slug);
    const tmp = this.confinedTarget(root, `.${current.slug}.candidate-${crypto.randomUUID()}`);
    const replacementBackup = this.confinedTarget(root, `.${current.slug}.replace-${crypto.randomUUID()}`);
    fs.mkdirSync(root, { recursive: true });
    if (fs.existsSync(target) && !current.baseSkillId) throw new Error("skill_slug_collision");
    if (current.baseSkillId) this.snapshotLearned(current.baseSkillId, "before approved patch");
    try {
      fs.mkdirSync(tmp, { recursive: false });
      fs.writeFileSync(path.join(tmp, "SKILL.md"), current.proposedSkillMd, "utf8");
      for (const [relative, content] of Object.entries(current.packageFiles ?? {})) {
        const file = path.resolve(tmp, relative);
        if (file !== tmp && !file.startsWith(`${tmp}${path.sep}`)) throw new Error("candidate_path_escape");
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content, "utf8");
      }
      if (fs.existsSync(target)) fs.renameSync(target, replacementBackup);
      fs.renameSync(tmp, target);
      fs.rmSync(replacementBackup, { recursive: true, force: true });
    } catch (error) {
      fs.rmSync(tmp, { recursive: true, force: true });
      if (!fs.existsSync(target) && fs.existsSync(replacementBackup)) fs.renameSync(replacementBackup, target);
      throw error;
    }
    await this.deps.skills.discover();
    this.deps.sessionHost.invalidateAll();
    const approved = this.deps.store.put({
      ...current,
      status: "approved",
      validation,
      activatedPath: target,
      updatedAt: new Date().toISOString(),
    });
    const frontmatter = parseFrontmatter(current.proposedSkillMd).data;
    const previous = current.baseSkillId ? this.deps.store.getLearned(current.baseSkillId) : null;
    this.deps.store.putLearned(previous
      ? {
          ...previous,
          state: "active",
          sourceCandidateId: current.id,
          version: typeof frontmatter.version === "string" ? frontmatter.version : previous.version,
          contentHash: validation.contentHash,
          updatedAt: approved.updatedAt,
        }
      : {
          id: crypto.randomUUID(),
          slug: current.slug,
          name: current.name,
          scope: current.scope,
          ...(current.workspaceId ? { workspaceId: current.workspaceId } : {}),
          path: target,
          state: "active",
          pinned: false,
          createdBy: current.createdBy,
          sourceCandidateId: current.id,
          version: typeof frontmatter.version === "string" ? frontmatter.version : "0.1.0",
          contentHash: validation.contentHash,
          createdAt: approved.updatedAt,
          updatedAt: approved.updatedAt,
          views: 0,
          uses: 0,
          successes: 0,
          failures: 0,
          corrections: 0,
          patches: 0,
        });
    return approved;
  }

  removeSource(threadId: string): { updated: number; deleted: number } {
    return this.deps.store.removeSource(threadId);
  }

  deleteWorkspace(workspaceId: string): number {
    return this.deps.store.deleteWorkspace(workspaceId);
  }

  listLearned(): LearnedSkill[] {
    return this.deps.store.listLearned();
  }

  reviewContextForSkill(
    skillPath: string,
    includeContent = false,
  ): { id: string; contentHash: string; skillMd?: string; packageFiles?: Record<string, string> } | null {
    const learned = this.deps.store.findLearnedByPath(skillPath);
    if (!learned || learned.state === "archived" || learned.pinned || learned.createdBy === "user") return null;
    try {
      if (!includeContent) return { id: learned.id, contentHash: learned.contentHash };
      const files = this.readPackage(learned.path);
      return {
        id: learned.id,
        contentHash: learned.contentHash,
        skillMd: files["SKILL.md"] ?? "",
        packageFiles: Object.fromEntries(Object.entries(files).filter(([name]) => name !== "SKILL.md")),
      };
    } catch {
      return null;
    }
  }

  recordTelemetry(id: string, event: "view" | "use" | "success" | "failure" | "correction" | "patch"): LearnedSkill {
    const skill = this.requireLearned(id);
    const field = ({ view: "views", use: "uses", success: "successes", failure: "failures", correction: "corrections", patch: "patches" } as const)[event];
    const now = new Date().toISOString();
    return this.deps.store.putLearned({
      ...skill,
      [field]: skill[field] + 1,
      ...(event === "use" || event === "success" ? { lastUsedAt: now } : {}),
      updatedAt: now,
    });
  }

  recordViewByPath(skillPath: string): void {
    const learned = this.deps.store.findLearnedByPath(path.dirname(skillPath));
    if (learned) this.recordTelemetry(learned.id, "view");
  }

  recordUseByPath(skillPath: string): void {
    const learned = this.deps.store.findLearnedByPath(path.dirname(skillPath));
    if (learned) this.recordTelemetry(learned.id, "use");
  }

  learnedIdForToolCall(toolName: string, rawArguments: string, cwd: string): string | null {
    if (toolName !== "read") return null;
    try {
      const args = JSON.parse(rawArguments) as { path?: unknown; file_path?: unknown };
      const requested = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : "";
      if (!requested || path.basename(requested) !== "SKILL.md") return null;
      const skillPath = path.dirname(path.isAbsolute(requested) ? requested : path.resolve(cwd, requested));
      return this.deps.store.findLearnedByPath(skillPath)?.id ?? null;
    } catch {
      return null;
    }
  }

  stagePatchFromFeedback(
    id: string,
    input: { outcome: "success" | "failure" | "correction"; sourceThreadId?: string; proposedSkillMd?: string; summary?: string },
  ): SkillCandidate | null {
    const skill = this.recordTelemetry(id, input.outcome);
    if (skill.createdBy === "user" || skill.pinned) throw new Error("learned_skill_not_managed");
    if ((input.outcome === "success" || !input.proposedSkillMd) && input.outcome !== "correction") return null;
    if (!input.proposedSkillMd) return null;
    const fm = parseFrontmatter(input.proposedSkillMd).data;
    const activePackage = this.readPackage(skill.path);
    const packageFiles = Object.fromEntries(Object.entries(activePackage).filter(([name]) => name !== "SKILL.md"));
    const candidate = this.stage({
      name: skill.slug,
      description: typeof fm.description === "string" ? fm.description : `Patch ${skill.name}`,
      triggerConditions: [typeof fm.whenToUse === "string" ? fm.whenToUse : "when this learned Skill applies"],
      scope: skill.scope,
      ...(skill.workspaceId ? { workspaceId: skill.workspaceId } : {}),
      proposedSkillMd: input.proposedSkillMd,
      ...(Object.keys(packageFiles).length ? { packageFiles } : {}),
      requiredTools: [],
      sourceThreadIds: input.sourceThreadId ? [input.sourceThreadId] : [],
      evidence: input.sourceThreadId
        ? [{ sourceThreadId: input.sourceThreadId, summary: input.summary ?? `${input.outcome} feedback` }]
        : [],
      reason: input.summary ?? `Patch proposed from ${input.outcome} feedback`,
      createdBy: "foreground-agent",
      baseSkillId: skill.id,
      baseContentHash: skill.contentHash,
    });
    this.recordTelemetry(id, "patch");
    return candidate;
  }

  pinLearned(id: string, pinned: boolean): LearnedSkill {
    const skill = this.requireLearned(id);
    return this.deps.store.putLearned({ ...skill, pinned, updatedAt: new Date().toISOString() });
  }

  snapshotLearned(id: string, reason: string): SkillSnapshot {
    const skill = this.requireLearned(id);
    const packageFiles = this.readPackage(skill.path);
    return this.deps.store.putSnapshot({
      id: crypto.randomUUID(),
      learnedSkillId: id,
      reason,
      packageFiles,
      createdAt: new Date().toISOString(),
    });
  }

  archiveLearned(id: string): LearnedSkill {
    const skill = this.requireLearned(id);
    if (skill.pinned) throw new Error("learned_skill_pinned");
    if (skill.createdBy === "user") throw new Error("learned_skill_not_managed");
    this.snapshotLearned(id, "before archive");
    const archivedPath = path.join(this.deps.archiveDir, id, `${Date.now()}-${skill.slug}`);
    fs.mkdirSync(path.dirname(archivedPath), { recursive: true });
    fs.renameSync(skill.path, archivedPath);
    const next = this.deps.store.putLearned({
      ...skill,
      state: "archived",
      archivedPath,
      updatedAt: new Date().toISOString(),
    });
    void this.deps.skills.discover();
    this.deps.sessionHost.invalidateAll();
    return next;
  }

  restoreLearned(id: string): LearnedSkill {
    const skill = this.requireLearned(id);
    if (skill.state !== "archived" || !skill.archivedPath) throw new Error("learned_skill_not_archived");
    if (fs.existsSync(skill.path)) throw new Error("skill_restore_collision");
    fs.mkdirSync(path.dirname(skill.path), { recursive: true });
    fs.renameSync(skill.archivedPath, skill.path);
    const next = this.deps.store.putLearned({
      ...skill,
      state: "active",
      archivedPath: undefined,
      updatedAt: new Date().toISOString(),
    });
    void this.deps.skills.discover();
    this.deps.sessionHost.invalidateAll();
    return next;
  }

  rollbackLearned(id: string, snapshotId: string): LearnedSkill {
    const skill = this.requireLearned(id);
    if (skill.state === "archived") throw new Error("learned_skill_archived");
    const snapshot = this.deps.store.getSnapshot(snapshotId);
    if (!snapshot || snapshot.learnedSkillId !== id) throw new Error("skill_snapshot_not_found");
    this.snapshotLearned(id, "before rollback");
    fs.rmSync(skill.path, { recursive: true, force: true });
    this.writePackage(skill.path, snapshot.packageFiles);
    const skillMd = snapshot.packageFiles["SKILL.md"] ?? "";
    const restored = this.deps.store.putLearned({
      ...skill,
      state: "active",
      contentHash: packageContentHash(
        skillMd,
        Object.fromEntries(Object.entries(snapshot.packageFiles).filter(([name]) => name !== "SKILL.md")),
      ),
      updatedAt: new Date().toISOString(),
    });
    void this.deps.skills.discover();
    this.deps.sessionHost.invalidateAll();
    return restored;
  }

  curate(now = new Date()): { stale: string[]; archived: string[]; messages: string[] } {
    const stale: string[] = [];
    const archived: string[] = [];
    const messages: string[] = [];
    const ageDays = (iso: string) => (now.getTime() - Date.parse(iso)) / 86_400_000;
    for (const skill of this.deps.store.listLearned()) {
      if (skill.pinned || skill.createdBy === "user" || skill.state === "archived") continue;
      const last = skill.lastUsedAt ?? skill.createdAt;
      if (skill.state === "active" && ageDays(last) >= 30) {
        this.snapshotLearned(skill.id, "before curator stale transition");
        this.deps.store.putLearned({ ...skill, state: "stale", updatedAt: now.toISOString() });
        stale.push(skill.id);
        messages.push(`${skill.slug}: active → stale (inactive for at least 30 days)`);
      } else if (skill.state === "stale" && ageDays(skill.updatedAt) >= 30) {
        this.archiveLearned(skill.id);
        archived.push(skill.id);
        messages.push(`${skill.slug}: stale → archived (recoverable snapshot created)`);
      }
    }
    if (messages.length === 0) messages.push("No learned Skill lifecycle changes were needed.");
    return { stale, archived, messages };
  }

  listSnapshots(id?: string): SkillSnapshot[] {
    return this.deps.store.listSnapshots(id);
  }

  private requirePending(id: string): SkillCandidate {
    const candidate = this.deps.store.get(id);
    if (!candidate) throw new Error("candidate_not_found");
    if (candidate.status !== "pending") throw new Error("candidate_not_pending");
    return candidate;
  }

  private requireLearned(id: string): LearnedSkill {
    const skill = this.deps.store.getLearned(id);
    if (!skill) throw new Error("learned_skill_not_found");
    return skill;
  }

  private readPackage(root: string): Record<string, string> {
    const out: Record<string, string> = {};
    let count = 0;
    let bytes = 0;
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) throw new Error("skill_package_symlink");
        if (entry.isDirectory()) walk(file);
        else {
          if (!entry.isFile()) throw new Error("skill_package_non_regular_file");
          count++;
          bytes += fs.statSync(file).size;
          if (count > MAX_PACKAGE_FILES || bytes > MAX_PACKAGE_BYTES) throw new Error("skill_package_too_large");
          out[path.relative(root, file).split(path.sep).join("/")] = fs.readFileSync(file, "utf8");
        }
      }
    };
    walk(root);
    return out;
  }

  private writePackage(root: string, files: Record<string, string>): void {
    fs.mkdirSync(root, { recursive: true });
    for (const [relative, content] of Object.entries(files)) {
      const file = path.resolve(root, relative);
      if (!file.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error("skill_snapshot_path_escape");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, "utf8");
    }
  }

  private targetRoot(candidate: SkillCandidate): string {
    if (candidate.scope === "global") return path.resolve(this.deps.skillsDir);
    const project = candidate.workspaceId ? this.deps.repo.getProject(candidate.workspaceId) : null;
    if (!project?.workspaceDir) throw new Error("candidate_workspace_not_found");
    let cursor = path.resolve(project.workspaceDir);
    for (const segment of [".agents", "skills"]) {
      cursor = path.join(cursor, segment);
      if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) {
        throw new Error("candidate_symlink_escape");
      }
    }
    return cursor;
  }

  private confinedTarget(root: string, slug: string): string {
    const target = path.resolve(root, slug);
    if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error("candidate_path_escape");
    let cursor = path.resolve(root);
    for (const part of path.relative(root, target).split(path.sep).slice(0, -1)) {
      cursor = path.join(cursor, part);
      if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error("candidate_symlink_escape");
    }
    return target;
  }
}
