import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveWorkspacePath } from "@ew/tools";

/** 工作区内一个改动文件的状态。 */
export interface GitFile {
  path: string;
  /** 暂存区状态字母（A/M/D/R…），未暂存为 " "。 */
  index: string;
  /** 工作区状态字母，未改为 " "；untracked 为 "?"。 */
  work: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  adds: number;
  dels: number;
}

export interface GitStatus {
  repo: boolean;
  branch?: string;
  files: GitFile[];
}

export interface BranchInfo {
  current: string;
  all: string[];
}

/** 一条提交记录（用于提交历史展示）。 */
export interface GitCommit {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  /** 相对时间（如「2 hours ago」）。 */
  relDate: string;
}

/** 远程跟踪信息（驱动 push/pull 的可用性与 ↑↓ 角标）。 */
export interface RemoteInfo {
  hasRemote: boolean;
  hasUpstream: boolean;
  ahead: number;
  behind: number;
  upstream?: string;
}

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** 在某工作区目录里执行 git 命令。所有方法都不抛（返回结构化结果/错误）。 */
export class GitService {
  constructor(private readonly root: string) {}

  private run(args: string[]): Promise<RunResult> {
    return new Promise((resolve) => {
      execFile(
        "git",
        args,
        { cwd: this.root, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => {
          resolve({ ok: !err, stdout: stdout ?? "", stderr: stderr ?? "" });
        },
      );
    });
  }

  /** 网络型 git（push/pull）：禁止任何交互凭证提示（否则会挂起），并加超时。 */
  private runNet(args: string[]): Promise<RunResult> {
    return new Promise((resolve) => {
      execFile(
        "git",
        args,
        {
          cwd: this.root,
          maxBuffer: 16 * 1024 * 1024,
          timeout: 60_000,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -oBatchMode=yes" },
        },
        (err, stdout, stderr) => {
          const timedOut = (err as { killed?: boolean } | null)?.killed;
          resolve({
            ok: !err,
            stdout: stdout ?? "",
            stderr: timedOut ? "操作超时（可能在等待凭证或网络无响应）" : (stderr ?? ""),
          });
        },
      );
    });
  }

  /** 把用户给的路径限定在工作区根内（越界抛错）；返回根内绝对路径供 git/-fs 使用。 */
  private safe(p: string): string {
    return resolveWorkspacePath(this.root, p);
  }

  async isRepo(): Promise<boolean> {
    const r = await this.run(["rev-parse", "--is-inside-work-tree"]);
    return r.ok && r.stdout.trim() === "true";
  }

  async status(): Promise<GitStatus> {
    if (!(await this.isRepo())) return { repo: false, files: [] };
    const branch = (await this.run(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim() || "HEAD";
    const unstaged = await this.numstat(["diff", "--numstat"]);
    const staged = await this.numstat(["diff", "--cached", "--numstat"]);
    const raw = (await this.run(["status", "--porcelain", "-z"])).stdout;
    const files: GitFile[] = [];
    const tokens = raw.split("\0");
    for (let i = 0; i < tokens.length; i++) {
      const entry = tokens[i];
      if (!entry) continue;
      const x = entry[0]!;
      const y = entry[1]!;
      const p = entry.slice(3);
      // 重命名/复制：下一个 token 是原路径，消费掉。
      if (x === "R" || x === "C") i++;
      const untracked = x === "?" && y === "?";
      const staged_ = !untracked && x !== " ";
      const unstaged_ = untracked || y !== " ";
      const counts = unstaged_ ? (unstaged.get(p) ?? this.untrackedCounts(p, untracked)) : staged.get(p);
      files.push({
        path: p,
        index: x,
        work: y,
        staged: staged_,
        unstaged: unstaged_,
        untracked,
        adds: counts?.adds ?? 0,
        dels: counts?.dels ?? 0,
      });
    }
    return { repo: true, branch, files };
  }

  /** 单文件 diff（unified）。staged=true 取暂存区 vs HEAD；untracked 用 --no-index vs /dev/null。 */
  async diff(filePath: string, opts?: { staged?: boolean }): Promise<string> {
    const abs = this.safe(filePath); // 沙箱校验：越界抛错
    if (opts?.staged) return (await this.run(["diff", "--cached", "--", abs])).stdout;
    const tracked = await this.run(["ls-files", "--error-unmatch", "--", abs]);
    if (!tracked.ok) {
      // untracked：与空对比（--no-index 返回非 0，但 stdout 是 diff）。
      const r = await this.run(["diff", "--no-index", "--", "/dev/null", abs]);
      return r.stdout;
    }
    return (await this.run(["diff", "--", abs])).stdout;
  }

  async stage(paths: string[]): Promise<RunResult> {
    return this.run(["add", "--", ...paths.map((p) => this.safe(p))]);
  }
  async stageAll(): Promise<RunResult> {
    return this.run(["add", "-A"]);
  }
  async unstage(paths: string[]): Promise<RunResult> {
    return this.run(["restore", "--staged", "--", ...paths.map((p) => this.safe(p))]);
  }
  async unstageAll(): Promise<RunResult> {
    return this.run(["restore", "--staged", "--", "."]);
  }

  async commit(message: string): Promise<RunResult> {
    return this.run(["commit", "-m", message]);
  }

  /** 丢弃改动：untracked 删文件；tracked 取消暂存 + 还原工作区。路径限定在工作区内。 */
  async revert(paths: string[]): Promise<RunResult> {
    for (const raw of paths) {
      const abs = this.safe(raw); // 越界抛错，绝不删工作区外文件
      const tracked = await this.run(["ls-files", "--error-unmatch", "--", abs]);
      if (tracked.ok) {
        await this.run(["restore", "--staged", "--worktree", "--", abs]);
      } else {
        try {
          fs.rmSync(abs, { force: true, recursive: true });
        } catch {
          /* ignore */
        }
      }
    }
    return { ok: true, stdout: "", stderr: "" };
  }

  async revertAll(): Promise<RunResult> {
    await this.run(["restore", "--staged", "--worktree", "--", "."]);
    return { ok: true, stdout: "", stderr: "" };
  }

  async branches(): Promise<BranchInfo> {
    if (!(await this.isRepo())) return { current: "", all: [] };
    const current = (await this.run(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
    const out = (await this.run(["branch", "--format=%(refname:short)"])).stdout;
    const all = out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    return { current, all };
  }

  async switchBranch(name: string): Promise<RunResult> {
    return this.run(["checkout", name]);
  }

  /** 最近提交（默认 30，封顶 200）。用 \x1f/\x1e 分隔，避免主题里的特殊字符歧义。 */
  async log(limit = 30): Promise<GitCommit[]> {
    if (!(await this.isRepo())) return [];
    const n = Math.max(1, Math.min(Math.floor(limit) || 30, 200));
    const r = await this.run([
      "log",
      "-n",
      String(n),
      "--date=relative",
      "--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%ad%x1e",
    ]);
    if (!r.ok || !r.stdout.trim()) return []; // 无提交（新仓库）→ 空
    return r.stdout
      .split("\x1e")
      .map((rec) => rec.trim())
      .filter(Boolean)
      .map((rec) => {
        const [hash, shortHash, subject, author, relDate] = rec.split("\x1f");
        return {
          hash: hash ?? "",
          shortHash: shortHash ?? "",
          subject: subject ?? "",
          author: author ?? "",
          relDate: relDate ?? "",
        };
      });
  }

  /** 远程/上游与 ahead/behind 计数。 */
  async remoteInfo(): Promise<RemoteInfo> {
    if (!(await this.isRepo())) return { hasRemote: false, hasUpstream: false, ahead: 0, behind: 0 };
    const hasRemote = (await this.run(["remote"])).stdout.trim().length > 0;
    const up = await this.run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
    const hasUpstream = up.ok && up.stdout.trim().length > 0;
    let ahead = 0;
    let behind = 0;
    if (hasUpstream) {
      const c = await this.run(["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]);
      if (c.ok) {
        const [b, a] = c.stdout.trim().split(/\s+/);
        behind = Number(b) || 0;
        ahead = Number(a) || 0;
      }
    }
    return { hasRemote, hasUpstream, ahead, behind, ...(hasUpstream ? { upstream: up.stdout.trim() } : {}) };
  }

  /** 推送。无上游时回退 `push -u origin <branch>`（首次推送）；无 origin 则报错。 */
  async push(): Promise<RunResult> {
    const up = await this.run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
    if (up.ok && up.stdout.trim()) return this.runNet(["push"]);
    const hasOrigin = (await this.run(["remote"])).stdout
      .split("\n")
      .map((s) => s.trim())
      .includes("origin");
    if (!hasOrigin) return { ok: false, stdout: "", stderr: "没有配置远程仓库（origin）" };
    const branch = (await this.run(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim() || "HEAD";
    return this.runNet(["push", "-u", "origin", branch]);
  }

  /** 拉取（仅 fast-forward，避免产生合并提交/冲突阻塞）。 */
  async pull(): Promise<RunResult> {
    return this.runNet(["pull", "--ff-only"]);
  }

  /**
   * 单个改动块（hunk）的接受/拒绝（部分暂存）。从该文件当前 diff 取第 hunkIndex 个 hunk
   * 构造最小补丁，再 `git apply` 落到 index/工作区：
   * - stage：未暂存 diff → `apply --cached`（接受到暂存区）
   * - unstage：已暂存 diff → `apply --cached --reverse`（从暂存区移出）
   * - discard：未暂存 diff → `apply --reverse`（从工作区丢弃，destructive）
   * hunkIndex 与前端按同一份 diff 的 @@ 顺序对齐。untracked 文件不支持（按整文件操作）。
   */
  async hunkOp(filePath: string, hunkIndex: number, op: "stage" | "unstage" | "discard"): Promise<RunResult> {
    const abs = this.safe(filePath); // 越界抛错
    const fileDiff =
      op === "unstage"
        ? (await this.run(["diff", "--cached", "--", abs])).stdout
        : (await this.run(["diff", "--", abs])).stdout;
    const patch = buildHunkPatch(fileDiff, hunkIndex);
    if (!patch) return { ok: false, stdout: "", stderr: "找不到该改动块（可能已变化，请刷新）" };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ew-hunk-"));
    const file = path.join(dir, "hunk.patch");
    try {
      fs.writeFileSync(file, patch);
      const flags =
        op === "stage"
          ? ["apply", "--cached", "--recount", file]
          : op === "unstage"
            ? ["apply", "--cached", "--reverse", "--recount", file]
            : ["apply", "--reverse", "--recount", file];
      return await this.run(flags);
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }

  private async numstat(args: string[]): Promise<Map<string, { adds: number; dels: number }>> {
    const out = (await this.run(args)).stdout;
    const map = new Map<string, { adds: number; dels: number }>();
    for (const line of out.split("\n")) {
      if (!line.trim()) continue;
      const [a, d, ...rest] = line.split("\t");
      const p = renameTarget(rest.join("\t"));
      if (!p) continue;
      map.set(p, { adds: a === "-" ? 0 : Number(a) || 0, dels: d === "-" ? 0 : Number(d) || 0 });
    }
    return map;
  }

  /** untracked 文件没有 diff 记录，用行数近似 adds（受大小限制）。 */
  private untrackedCounts(p: string, untracked: boolean): { adds: number; dels: number } | undefined {
    if (!untracked) return undefined;
    try {
      const buf = fs.readFileSync(path.join(this.root, p));
      if (buf.length > 512 * 1024) return { adds: 0, dels: 0 };
      const text = buf.toString("utf8");
      const adds = text.length ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0;
      return { adds, dels: 0 };
    } catch {
      return { adds: 0, dels: 0 };
    }
  }
}

/**
 * 从单文件 unified diff 抽出第 index 个 hunk，拼成可独立 `git apply` 的最小补丁
 * （文件头 `diff --git`/`---`/`+++` + 该 @@ 块）。索引/找不到则返回 null。
 */
function buildHunkPatch(fileDiff: string, index: number): string | null {
  if (!fileDiff.trim()) return null;
  const lines = fileDiff.split("\n");
  const firstHunk = lines.findIndex((l) => l.startsWith("@@"));
  if (firstHunk === -1) return null;
  const header = lines.slice(0, firstHunk);
  const starts: number[] = [];
  for (let i = firstHunk; i < lines.length; i++) if (lines[i]!.startsWith("@@")) starts.push(i);
  if (index < 0 || index >= starts.length) return null;
  const start = starts[index]!;
  const end = index + 1 < starts.length ? starts[index + 1]! : lines.length;
  const body = lines.slice(start, end);
  return [...header, ...body].join("\n").replace(/\n*$/, "\n");
}

/**
 * numstat 把重命名记成 `old => new`（或带公共前后缀的花括号形式 `pre{old => new}post`）。
 * status --porcelain 用新路径作 key，故归一到新路径，使计数能对上。
 */
function renameTarget(p: string): string {
  const arrow = p.indexOf(" => ");
  if (arrow === -1) return p;
  const open = p.indexOf("{");
  const close = p.indexOf("}");
  if (open !== -1 && close !== -1 && open < arrow && arrow < close) {
    return p.slice(0, open) + p.slice(arrow + 4, close) + p.slice(close + 1);
  }
  return p.slice(arrow + 4);
}
