import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolExecContext, ToolResult } from "@ew/shared";
import { makeFsTools } from "../src/fs-tools.js";

let root: string | undefined;
function freshRoot(): string {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ew-fs-")));
  return root;
}
afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function ctxFor(r: string): ToolExecContext {
  return { sessionId: "s", workspaceDir: r, signal: new AbortController().signal, approval: { request: async () => "approve" } };
}
const tool = (name: string, includeWrite = true) => {
  const t = makeFsTools({ writeApproval: "always", includeWrite }).find((x) => x.definition.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};
const run = (name: string, args: unknown, r: string): Promise<ToolResult> => tool(name).execute(args, ctxFor(r));

describe("fs 工具族", () => {
  it("fs_write 新建 + fs_read 往返 + diff display", async () => {
    const r = freshRoot();
    const w = await run("fs_write", { path: "src/a.ts", content: "line1\nline2\n" }, r);
    expect(w.isError).toBeFalsy();
    expect((w.display as { kind: string; before: unknown }).kind).toBe("diff");
    expect((w.display as { before: unknown }).before).toBeNull(); // 新文件
    expect(fs.readFileSync(path.join(r, "src/a.ts"), "utf8")).toBe("line1\nline2\n");
    const read = await run("fs_read", { path: "src/a.ts" }, r);
    expect(read.content).toContain("line1");
    expect(read.content).toMatch(/\s+1\tline1/); // 带行号
  });

  it("fs_edit 唯一匹配替换 + 多匹配歧义报错", async () => {
    const r = freshRoot();
    fs.writeFileSync(path.join(r, "f.txt"), "foo bar foo");
    const ambiguous = await run("fs_edit", { path: "f.txt", old_string: "foo", new_string: "X" }, r);
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.content).toContain("2 次");
    const ok = await run("fs_edit", { path: "f.txt", old_string: "bar", new_string: "BAZ" }, r);
    expect(ok.isError).toBeFalsy();
    expect(fs.readFileSync(path.join(r, "f.txt"), "utf8")).toBe("foo BAZ foo");
    // replace_all
    const all = await run("fs_edit", { path: "f.txt", old_string: "foo", new_string: "Q", replace_all: true }, r);
    expect(all.isError).toBeFalsy();
    expect(fs.readFileSync(path.join(r, "f.txt"), "utf8")).toBe("Q BAZ Q");
  });

  it("fs_edit old_string 未找到报错", async () => {
    const r = freshRoot();
    fs.writeFileSync(path.join(r, "f.txt"), "hello");
    const res = await run("fs_edit", { path: "f.txt", old_string: "nope", new_string: "x" }, r);
    expect(res.isError).toBe(true);
  });

  it("二进制文件 fs_read 拒绝", async () => {
    const r = freshRoot();
    fs.writeFileSync(path.join(r, "bin"), Buffer.from([1, 2, 0, 3, 4]));
    const res = await run("fs_read", { path: "bin" }, r);
    expect(res.isError).toBe(true);
    expect(res.content).toContain("二进制");
  });

  it("fs_list 列目录 + 跳过 node_modules", async () => {
    const r = freshRoot();
    fs.mkdirSync(path.join(r, "src"));
    fs.writeFileSync(path.join(r, "src/x.ts"), "x");
    fs.mkdirSync(path.join(r, "node_modules"));
    fs.writeFileSync(path.join(r, "node_modules/pkg.js"), "y");
    const res = await run("fs_list", { path: ".", depth: 3 }, r);
    expect(res.content).toContain("src");
    expect(res.content).not.toContain("node_modules");
    const entries = (res.display as { entries: { path: string }[] }).entries;
    expect(entries.some((e) => e.path === "src/x.ts")).toBe(true);
  });

  it("fs_grep 命中 path:line:text", async () => {
    const r = freshRoot();
    fs.writeFileSync(path.join(r, "a.ts"), "const foo = 1\nconst bar = 2");
    const res = await run("fs_grep", { pattern: "bar" }, r);
    expect(res.content).toMatch(/a\.ts:2:/);
    const bad = await run("fs_grep", { pattern: "[invalid(" }, r);
    expect(bad.isError).toBe(true);
  });

  it("越界路径被拒绝", async () => {
    const r = freshRoot();
    const res = await run("fs_read", { path: "../../etc/passwd" }, r);
    expect(res.isError).toBe(true);
    expect(res.content).toContain("越界");
  });

  it("read-only 模式不暴露写工具", () => {
    const names = makeFsTools({ includeWrite: false }).map((t) => t.definition.name);
    expect(names).toEqual(["fs_list", "fs_read", "fs_grep"]);
  });
});
