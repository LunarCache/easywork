import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveWorkspacePath } from "../src/path-sandbox.js";

let root: string | undefined;
let outside: string | undefined;
function freshRoot(): string {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ew-ws-")));
  return root;
}
afterEach(() => {
  for (const d of [root, outside]) if (d) fs.rmSync(d, { recursive: true, force: true });
  root = outside = undefined;
});

describe("resolveWorkspacePath", () => {
  it("相对路径解析到根内", () => {
    const r = freshRoot();
    expect(resolveWorkspacePath(r, "src/index.ts")).toBe(path.join(r, "src/index.ts"));
    expect(resolveWorkspacePath(r, ".")).toBe(r);
    expect(resolveWorkspacePath(r, "./a/../b")).toBe(path.join(r, "b"));
  });

  it("`..` 越界被拒绝", () => {
    const r = freshRoot();
    expect(() => resolveWorkspacePath(r, "../escape")).toThrow(/越界/);
    expect(() => resolveWorkspacePath(r, "a/../../escape")).toThrow(/越界/);
  });

  it("根下绝对路径放行，根外绝对路径拒绝", () => {
    const r = freshRoot();
    expect(resolveWorkspacePath(r, path.join(r, "x/y"))).toBe(path.join(r, "x/y"));
    expect(() => resolveWorkspacePath(r, "/etc/passwd")).toThrow(/越界/);
  });

  it("符号链接逃逸被拒绝", () => {
    const r = freshRoot();
    outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ew-out-")));
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
    // 在工作区内造一个指向工作区外目录的软链。
    fs.symlinkSync(outside, path.join(r, "link"));
    expect(() => resolveWorkspacePath(r, "link/secret.txt")).toThrow(/越界/);
  });

  it("写新文件：校验已存在父目录（父目录在根内则放行）", () => {
    const r = freshRoot();
    fs.mkdirSync(path.join(r, "src"));
    expect(resolveWorkspacePath(r, "src/new-file.ts")).toBe(path.join(r, "src/new-file.ts"));
  });
});
