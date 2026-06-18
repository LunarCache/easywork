import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitService } from "../src/git/git.js";

let root: string;
function git(...args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ew-git-")));
  git("init", "-q");
  git("config", "user.email", "t@t.com");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(root, "a.txt"), "line1\nline2\n");
  git("add", "-A");
  git("commit", "-qm", "init");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("GitService", () => {
  it("非 git 目录优雅降级", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ew-nogit-"));
    const s = await new GitService(tmp).status();
    expect(s.repo).toBe(false);
    expect(s.files).toEqual([]);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("status：修改/新增文件 + 分支 + 计数", async () => {
    fs.writeFileSync(path.join(root, "a.txt"), "line1\nCHANGED\nline2\n");
    fs.writeFileSync(path.join(root, "new.txt"), "x\ny\n");
    const g = new GitService(root);
    const s = await g.status();
    expect(s.repo).toBe(true);
    expect(s.branch).toMatch(/main|master/);
    const a = s.files.find((f) => f.path === "a.txt")!;
    expect(a.unstaged).toBe(true);
    expect(a.adds).toBeGreaterThan(0);
    const nu = s.files.find((f) => f.path === "new.txt")!;
    expect(nu.untracked).toBe(true);
    expect(nu.adds).toBe(2); // 行数近似
  });

  it("stage / unstage 切换 staged 标志", async () => {
    fs.writeFileSync(path.join(root, "a.txt"), "z\n");
    const g = new GitService(root);
    await g.stage(["a.txt"]);
    let s = await g.status();
    expect(s.files.find((f) => f.path === "a.txt")!.staged).toBe(true);
    await g.unstage(["a.txt"]);
    s = await g.status();
    expect(s.files.find((f) => f.path === "a.txt")!.staged).toBe(false);
  });

  it("diff 返回 unified（含 +/-）", async () => {
    fs.writeFileSync(path.join(root, "a.txt"), "line1\nNEW\n");
    const d = await new GitService(root).diff("a.txt");
    expect(d).toContain("@@");
    expect(d).toContain("+NEW");
    expect(d).toContain("-line2");
  });

  it("commit 后工作区干净", async () => {
    fs.writeFileSync(path.join(root, "a.txt"), "committed\n");
    const g = new GitService(root);
    await g.stageAll();
    const r = await g.commit("change a");
    expect(r.ok).toBe(true);
    expect((await g.status()).files).toHaveLength(0);
  });

  it("revert 丢弃改动（tracked 还原 + untracked 删除）", async () => {
    fs.writeFileSync(path.join(root, "a.txt"), "dirty\n");
    fs.writeFileSync(path.join(root, "junk.txt"), "junk\n");
    const g = new GitService(root);
    await g.revert(["a.txt", "junk.txt"]);
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("line1\nline2\n");
    expect(fs.existsSync(path.join(root, "junk.txt"))).toBe(false);
  });

  it("branches：当前 + 列表", async () => {
    git("branch", "feature");
    const b = await new GitService(root).branches();
    expect(b.all).toContain("feature");
    expect(b.current).toMatch(/main|master/);
  });

  it("重命名+编辑：status 用新路径且计数对得上（numstat old => new 归一）", async () => {
    fs.writeFileSync(path.join(root, "a.txt"), "line1\nline2\nline3\n");
    git("add", "-A");
    git("commit", "-qm", "grow");
    git("mv", "a.txt", "b.txt");
    fs.writeFileSync(path.join(root, "b.txt"), "line1\nline2\nline3\nline4\n");
    git("add", "-A");
    const s = await new GitService(root).status();
    const b = s.files.find((f) => f.path === "b.txt");
    expect(b).toBeTruthy();
    expect(b!.adds).toBeGreaterThan(0); // 计数不再因 "a.txt => b.txt" key 而丢成 0
  });

  it("路径沙箱：diff/revert 拒绝越界路径（不读/删工作区外）", async () => {
    const g = new GitService(root);
    await expect(g.diff("../../../../etc/passwd")).rejects.toThrow(/越界/);
    // revert 越界路径应抛错，绝不 rmSync 工作区外
    await expect(g.revert(["../../../../tmp/should-not-delete"])).rejects.toThrow(/越界/);
  });

  it("log：返回最近提交（含 init），新增提交后置顶", async () => {
    const g = new GitService(root);
    let log = await g.log();
    expect(log.length).toBe(1);
    expect(log[0]!.subject).toBe("init");
    expect(log[0]!.shortHash).toMatch(/^[0-9a-f]+$/);
    fs.writeFileSync(path.join(root, "a.txt"), "x\n");
    git("add", "-A");
    git("commit", "-qm", "second");
    log = await g.log();
    expect(log.length).toBe(2);
    expect(log[0]!.subject).toBe("second"); // 最新在前
  });

  it("remoteInfo / push：无远程时优雅报告（不挂起）", async () => {
    const g = new GitService(root);
    const rm = await g.remoteInfo();
    expect(rm.hasRemote).toBe(false);
    expect(rm.hasUpstream).toBe(false);
    const r = await g.push();
    expect(r.ok).toBe(false);
    expect(r.stderr).toMatch(/没有配置远程仓库/);
  });

  it("remoteInfo：有 origin 但无上游 → hasRemote=true / hasUpstream=false", async () => {
    git("remote", "add", "origin", "https://example.invalid/repo.git");
    const rm = await new GitService(root).remoteInfo();
    expect(rm.hasRemote).toBe(true);
    expect(rm.hasUpstream).toBe(false);
  });

  // 造一个有两处相隔改动（两个 hunk）的文件。
  function twoHunkFile(): GitService {
    const f = path.join(root, "multi.txt");
    const base = Array.from({ length: 20 }, (_, i) => `L${i}`);
    fs.writeFileSync(f, base.join("\n") + "\n");
    git("add", "-A");
    git("commit", "-qm", "base");
    const next = [...base];
    next[1] = "L1-CHANGED";
    next[18] = "L18-CHANGED";
    fs.writeFileSync(f, next.join("\n") + "\n");
    return new GitService(root);
  }

  it("hunkOp stage：仅暂存选中的块（部分暂存）", async () => {
    const g = twoHunkFile();
    const full = await g.diff("multi.txt");
    expect(full.split("\n").filter((l) => l.startsWith("@@")).length).toBe(2); // 两个 hunk
    const r = await g.hunkOp("multi.txt", 0, "stage");
    expect(r.ok).toBe(true);
    const cached = await g.diff("multi.txt", { staged: true });
    const unstaged = await g.diff("multi.txt");
    expect(cached).toContain("L1-CHANGED");
    expect(cached).not.toContain("L18-CHANGED");
    expect(unstaged).toContain("L18-CHANGED");
    expect(unstaged).not.toContain("L1-CHANGED");
  });

  it("hunkOp discard：仅丢弃选中块（其余改动保留）", async () => {
    const g = twoHunkFile();
    const r = await g.hunkOp("multi.txt", 1, "discard");
    expect(r.ok).toBe(true);
    const content = fs.readFileSync(path.join(root, "multi.txt"), "utf8");
    expect(content).toContain("L1-CHANGED"); // 第一处仍在
    expect(content).not.toContain("L18-CHANGED"); // 第二处被丢弃
  });
});
