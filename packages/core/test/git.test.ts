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
});
