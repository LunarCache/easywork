import fs from "node:fs";
import fsPath from "node:path";
import os from "node:os";
import { z } from "zod";
import {
  ApprovalModeSchema,
  mimeForName,
  resolvePreviewKind,
  workspaceScope,
  type PreviewMeta,
} from "@ew/shared";
import { SkillManager, type SkillSourceConfig } from "@ew/skills";
import { listDir, readFileSafe, readRawSafe, statFileSafe } from "@ew/tools";
import { GitService } from "../../git/git.js";
import { chatWorkspaceDir, defaultWorkspaceDir } from "../../config/paths.js";
import type { SqliteConversationRepo } from "../../store/conversation.js";
import type { CoreHttpContext } from "../context.js";

const ProjectCreateSchema = z.object({
  name: z.string().min(1).optional(),
  workspaceDir: z.string().optional(),
  approvalMode: ApprovalModeSchema.optional(),
  instructions: z.string().optional(),
});
const ProjectPatchSchema = ProjectCreateSchema.partial();
const GitPathsSchema = z.object({ paths: z.array(z.string()).optional(), all: z.boolean().optional() });
const HunkSchema = z.object({
  path: z.string().min(1),
  hunkIndex: z.number().int().min(0),
  op: z.enum(["stage", "unstage", "discard"]),
});


/** 默认工作区下下一个可用的 NewProject{N} 路径（仅计算，不创建目录——真正聊天时才落盘）。 */
function nextNewProjectDir(repo: SqliteConversationRepo): string {
  const root = defaultWorkspaceDir();
  const used = new Set<number>();
  for (const p of repo.listProjects()) {
    const m = p.workspaceDir ? /(?:^|[\\/])NewProject(\d+)$/.exec(p.workspaceDir) : null;
    if (m) used.add(Number(m[1]));
  }
  try {
    for (const e of fs.readdirSync(root)) {
      const m = /^NewProject(\d+)$/.exec(e);
      if (m) used.add(Number(m[1]));
    }
  } catch {
    /* root 可能尚不存在 */
  }
  let n = 1;
  while (used.has(n)) n++;
  return fsPath.join(root, `NewProject${n}`);
}

function isExistingDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function findGitRoot(startDir: string): string | null {
  let dir = fsPath.resolve(startDir);
  for (;;) {
    if (fs.existsSync(fsPath.join(dir, ".git"))) return dir;
    const parent = fsPath.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function projectSkillSources(workspaceDir: string): SkillSourceConfig[] {
  const root = fsPath.resolve(workspaceDir);
  const gitRoot = findGitRoot(root);
  const agentsHome = process.env.AGENTS_HOME || fsPath.join(os.homedir(), ".agents");
  const userAgentsSkillsDir = fsPath.resolve(agentsHome, "skills");
  const sources: SkillSourceConfig[] = [];
  const addSource = (id: string, label: string, dir: string) => {
    const resolved = fsPath.resolve(dir);
    if (resolved === userAgentsSkillsDir || !isExistingDir(resolved)) return;
    sources.push({ id, label, kind: "project", dir: resolved });
  };

  addSource("project-pi", "工作区 Skills", fsPath.join(root, ".pi", "skills"));

  let dir = root;
  let index = 0;
  for (;;) {
    addSource(
      index === 0 ? "project-agents" : `project-agents-${index + 1}`,
      index === 0 ? "工作区标准目录" : "上级工作区标准目录",
      fsPath.join(dir, ".agents", "skills"),
    );
    if (gitRoot && dir === gitRoot) break;
    const parent = fsPath.dirname(dir);
    if (parent === dir) break;
    dir = parent;
    index += 1;
  }
  return sources;
}

function revealDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  void import("node:child_process").then(({ spawn }) => spawn(cmd, [dir], { detached: true, stdio: "ignore" }).unref());
}

export function registerWorkspaceRoutes(ctx: CoreHttpContext): void {
  const { app, repo, sessionHost, memory, skillCandidates } = ctx;

  // ---- 会话 ----
  app.get("/threads", async (req) => {
    const projectId = (req.query as { projectId?: string }).projectId;
    return { threads: repo.listThreads(projectId ? { projectId } : undefined) };
  });
  app.get("/threads/:id/messages", async (req) => ({
    messages: repo.history((req.params as { id: string }).id),
  }));
  // 该会话最后一轮的上下文用量（打开历史会话时回填进度环；无 pi 日志则 null）。
  app.get("/threads/:id/usage", async (req) => ({
    usage: sessionHost.lastUsage((req.params as { id: string }).id),
  }));
  // 手动压缩该会话上下文（pi session.compact()）；排进该 thread 的 run 串行链。无活动会话则 skipped。
  app.post("/threads/:id/compact", async (req) => sessionHost.compact((req.params as { id: string }).id));
  app.delete("/threads/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const projectId = repo.getThread(id)?.projectId;
    let facts = 0;
    try {
      await sessionHost.deleteThread(id, async () => {
        facts = await memory.deleteBySession(id);
        skillCandidates.removeSource(id);
        repo.deleteThread(id); // 删 SQLite 会话 + 消息 + FTS
      });
    } catch (e) {
      return reply.code(500).send({
        error: "thread_delete_failed",
        message: e instanceof Error ? e.message : String(e),
      });
    }
    // 对话会话（无项目）：删掉其每会话工件目录（软件 scratch；工作区会话用项目目录，不动）。
    if (!projectId) {
      try {
        fs.rmSync(chatWorkspaceDir(id), { recursive: true, force: true });
      } catch {
        /* 删工件目录失败不致命 */
      }
    }
    return { ok: true, factsRemoved: facts };
  });

  // ---- 工作区项目（Project = 本地目录 + 审批策略） ----
  app.get("/projects", async () => ({ projects: repo.listProjects() }));
  app.post("/projects", async (req, reply) => {
    const parsed = ProjectCreateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_project", detail: parsed.error.format() });
    if (parsed.data.workspaceDir && !isExistingDir(parsed.data.workspaceDir)) {
      return reply.code(400).send({ error: "invalid_dir", message: "workspaceDir 不是有效目录" });
    }
    // 未指定目录 → 解析默认工作区下的 NewProject{N} 路径（不预建目录，真正聊天时才落盘）。
    const workspaceDir = parsed.data.workspaceDir?.trim() || nextNewProjectDir(repo);
    const name = parsed.data.name?.trim() || fsPath.basename(workspaceDir);
    return repo.createProject({ ...parsed.data, name, workspaceDir });
  });
  app.patch("/projects/:id", async (req, reply) => {
    const parsed = ProjectPatchSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_project" });
    if (parsed.data.workspaceDir && !isExistingDir(parsed.data.workspaceDir)) {
      return reply.code(400).send({ error: "invalid_dir", message: "workspaceDir 不是有效目录" });
    }
    try {
      return repo.updateProject((req.params as { id: string }).id, parsed.data);
    } catch {
      return reply.code(404).send({ error: "not_found" });
    }
  });
  app.delete("/projects/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    try {
      // 每个来源会话先删其 derived facts 再删对话；随后清除剩余的独立工作区记忆。
      for (const t of repo.listThreads({ projectId: id })) {
        await sessionHost.deleteThread(t.id, async () => {
          await memory.deleteBySession(t.id);
          skillCandidates.removeSource(t.id);
          repo.deleteThread(t.id);
        });
      }
      await memory.deleteByScope(workspaceScope(id));
      skillCandidates.deleteWorkspace(id);
      repo.deleteProject(id);
      return { ok: true };
    } catch (e) {
      return reply.code(500).send({
        error: "project_delete_failed",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  });

  const projectRoot = (id: string): string => {
    const p = repo.getProject(id);
    if (!p?.workspaceDir) throw new Error("project_no_workspace");
    return p.workspaceDir;
  };

  app.get("/workspace/:id/skills", async (req, reply) => {
    try {
      const root = projectRoot((req.params as { id: string }).id);
      const sources = projectSkillSources(root);
      const manager = new SkillManager(sources);
      await manager.discover().catch(() => []);
      return { skills: manager.list(), sources };
    } catch (e) {
      return reply.code(404).send({ error: "not_found", message: e instanceof Error ? e.message : String(e) });
    }
  });

  // 工作区只读文件浏览（供 UI 文件树 / 文件查看）。写经 agent fs 工具走审批，不开直接写端点。
  app.get("/workspace/:id/fs/list", async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { path?: string; depth?: string };
    try {
      const root = projectRoot(id);
      // 工作区目录尚未落盘创建（首次聊天前）→ 视为空，不报错。
      if (!isExistingDir(root)) return { entries: [] };
      return { entries: listDir(root, q.path ?? ".", q.depth ? Number(q.depth) : 1) };
    } catch (e) {
      return reply.code(400).send({ error: "fs_error", message: e instanceof Error ? e.message : String(e) });
    }
  });

  // 对话模式工件浏览（只读）：每会话目录 <workspace>/chats/<threadId>，供右侧「工件」面板按会话展示产出。
  app.get("/chat/:threadId/files", async (req, reply) => {
    const { threadId } = req.params as { threadId: string };
    const q = req.query as { path?: string; depth?: string };
    try {
      const root = chatWorkspaceDir(threadId);
      if (!isExistingDir(root)) return { entries: [] }; // 尚未产出任何文件 → 空
      return { entries: listDir(root, q.path ?? ".", q.depth ? Number(q.depth) : 4) };
    } catch (e) {
      return reply.code(400).send({ error: "fs_error", message: e instanceof Error ? e.message : String(e) });
    }
  });

  // —— 统一文件预览（dock 文件 / 工件 共用）：scope=workspace|chat ——
  // /files/meta：渲染类型 + 文本类内联；/files/raw：原始字节（img/pdf 经 blob 渲染）。路径经 readFileSafe/readRawSafe 限定。
  const previewBase = (scope: string, id: string): string =>
    scope === "workspace" ? projectRoot(id) : chatWorkspaceDir(id);
  app.get("/terminal/context", async (req, reply) => {
    const q = req.query as { scope?: string; id?: string };
    if ((q.scope !== "workspace" && q.scope !== "chat") || !q.id) {
      return reply.code(400).send({ error: "params_required" });
    }
    try {
      const cwd = previewBase(q.scope, q.id);
      fs.mkdirSync(cwd, { recursive: true });
      return { cwd };
    } catch (e) {
      return reply.code(400).send({ error: "terminal_context_error", message: e instanceof Error ? e.message : String(e) });
    }
  });
  app.get("/files/meta", async (req, reply) => {
    const q = req.query as { scope?: string; id?: string; path?: string };
    if (!q.scope || !q.id || !q.path) return reply.code(400).send({ error: "params_required" });
    try {
      const base = previewBase(q.scope, q.id);
      const name = q.path.split(/[/\\]/).pop() || q.path;
      const kind = resolvePreviewKind(name);
      const mime = mimeForName(name);
      if (kind === "image" || kind === "pdf") {
        const { size } = statFileSafe(base, q.path);
        return { name, mime, kind, size } satisfies PreviewMeta;
      }
      const r = readFileSafe(base, q.path);
      if (r.binary) return { name, mime, kind: "binary", size: r.size } satisfies PreviewMeta;
      return { name, mime, kind, size: r.size, text: r.content ?? "", truncated: !!r.truncated } satisfies PreviewMeta;
    } catch (e) {
      return reply.code(400).send({ error: "fs_error", message: e instanceof Error ? e.message : String(e) });
    }
  });
  app.get("/files/raw", async (req, reply) => {
    const q = req.query as { scope?: string; id?: string; path?: string };
    if (!q.scope || !q.id || !q.path) return reply.code(400).send({ error: "params_required" });
    try {
      const raw = readRawSafe(previewBase(q.scope, q.id), q.path);
      const name = q.path.split(/[/\\]/).pop() || q.path;
      reply.header("content-type", mimeForName(name));
      reply.header("content-length", String(raw.buffer.length));
      reply.header("cache-control", "no-store");
      return reply.send(raw.buffer);
    } catch (e) {
      return reply.code(400).send({ error: "fs_error", message: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post("/workspace/:id/reveal", async (req, reply) => {
    try {
      const dir = projectRoot((req.params as { id: string }).id);
      revealDir(dir);
      return { ok: true, dir };
    } catch (e) {
      return reply.code(400).send({ error: "reveal_error", message: e instanceof Error ? e.message : String(e) });
    }
  });
  app.post("/chat/:threadId/reveal", async (req) => {
    const dir = chatWorkspaceDir((req.params as { threadId: string }).threadId);
    revealDir(dir);
    return { ok: true, dir };
  });

  // 工作区 git（status/diff/暂存/提交/还原/分支）。
  const git = (id: string): GitService => new GitService(projectRoot(id));
  app.get("/workspace/:id/git/status", async (req, reply) => {
    try {
      return await git((req.params as { id: string }).id).status();
    } catch {
      return reply.code(400).send({ error: "git_error" });
    }
  });
  app.get("/workspace/:id/git/diff", async (req, reply) => {
    const q = req.query as { path?: string; staged?: string };
    if (!q.path) return reply.code(400).send({ error: "path_required" });
    try {
      return { diff: await git((req.params as { id: string }).id).diff(q.path, { staged: q.staged === "1" }) };
    } catch {
      return reply.code(400).send({ error: "git_error" });
    }
  });
  app.get("/workspace/:id/git/branches", async (req, reply) => {
    try {
      return await git((req.params as { id: string }).id).branches();
    } catch {
      return reply.code(400).send({ error: "git_error" });
    }
  });
  app.post("/workspace/:id/git/stage", async (req, reply) => {
    try {
      const b = GitPathsSchema.parse(req.body ?? {});
      const g = git((req.params as { id: string }).id);
      const r = b.all || !b.paths?.length ? await g.stageAll() : await g.stage(b.paths);
      return { ok: r.ok, error: r.ok ? undefined : r.stderr };
    } catch {
      return reply.code(400).send({ error: "git_error" });
    }
  });
  app.post("/workspace/:id/git/unstage", async (req, reply) => {
    try {
      const b = GitPathsSchema.parse(req.body ?? {});
      const g = git((req.params as { id: string }).id);
      const r = b.all || !b.paths?.length ? await g.unstageAll() : await g.unstage(b.paths);
      return { ok: r.ok, error: r.ok ? undefined : r.stderr };
    } catch {
      return reply.code(400).send({ error: "git_error" });
    }
  });
  app.post("/workspace/:id/git/revert", async (req, reply) => {
    try {
      const b = GitPathsSchema.parse(req.body ?? {});
      const g = git((req.params as { id: string }).id);
      await (b.all || !b.paths?.length ? g.revertAll() : g.revert(b.paths));
      return { ok: true };
    } catch {
      return reply.code(400).send({ error: "git_error" });
    }
  });
  app.post("/workspace/:id/git/commit", async (req, reply) => {
    const b = z.object({ message: z.string().min(1) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "message_required" });
    try {
      const r = await git((req.params as { id: string }).id).commit(b.data.message);
      return { ok: r.ok, error: r.ok ? undefined : r.stderr || r.stdout };
    } catch {
      return reply.code(400).send({ error: "git_error" });
    }
  });
  app.post("/workspace/:id/git/switch", async (req, reply) => {
    const b = z.object({ name: z.string().min(1) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "name_required" });
    try {
      const r = await git((req.params as { id: string }).id).switchBranch(b.data.name);
      return { ok: r.ok, error: r.ok ? undefined : r.stderr };
    } catch {
      return reply.code(400).send({ error: "git_error" });
    }
  });
  app.get("/workspace/:id/git/log", async (req, reply) => {
    const q = req.query as { limit?: string };
    try {
      return { commits: await git((req.params as { id: string }).id).log(q.limit ? Number(q.limit) : 30) };
    } catch {
      return reply.code(400).send({ error: "git_error" });
    }
  });
  app.get("/workspace/:id/git/remote", async (req, reply) => {
    try {
      return await git((req.params as { id: string }).id).remoteInfo();
    } catch {
      return reply.code(400).send({ error: "git_error" });
    }
  });
  app.post("/workspace/:id/git/push", async (req, reply) => {
    try {
      const r = await git((req.params as { id: string }).id).push();
      return { ok: r.ok, message: (r.stderr || r.stdout).trim() };
    } catch {
      return reply.code(400).send({ error: "git_error" });
    }
  });
  app.post("/workspace/:id/git/pull", async (req, reply) => {
    try {
      const r = await git((req.params as { id: string }).id).pull();
      return { ok: r.ok, message: (r.stderr || r.stdout).trim() };
    } catch {
      return reply.code(400).send({ error: "git_error" });
    }
  });
  app.post("/workspace/:id/git/hunk", async (req, reply) => {
    const b = HunkSchema.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "bad_request" });
    try {
      const r = await git((req.params as { id: string }).id).hunkOp(b.data.path, b.data.hunkIndex, b.data.op);
      return { ok: r.ok, error: r.ok ? undefined : r.stderr || r.stdout };
    } catch {
      return reply.code(400).send({ error: "git_error" });
    }
  });
}
