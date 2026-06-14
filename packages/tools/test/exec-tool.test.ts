import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentEvent, ToolExecContext, ToolResult } from "@ew/shared";
import { makeExecTool, findGitBash } from "../src/exec-tool.js";

let root: string | undefined;
function freshRoot(): string {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ew-exec-")));
  return root;
}
afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function ctxFor(r: string, opts?: { signal?: AbortSignal; emit?: (e: { type: string; [k: string]: unknown }) => void }): ToolExecContext {
  return {
    sessionId: "s",
    workspaceDir: r,
    signal: opts?.signal ?? new AbortController().signal,
    approval: { request: async () => "approve" },
    ...(opts?.emit ? { emit: opts.emit } : {}),
  };
}
const exec = makeExecTool();
const run = (args: unknown, ctx: ToolExecContext): Promise<ToolResult> => exec.execute(args, ctx);

describe("run_command", () => {
  it("正常退出：stdout + exit 0", async () => {
    const r = freshRoot();
    const res = await run({ command: "echo hello" }, ctxFor(r));
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("hello");
    expect(res.content).toContain("[exit 0]");
  });

  it("非零退出 → isError", async () => {
    const r = freshRoot();
    const res = await run({ command: "exit 3" }, ctxFor(r));
    expect(res.isError).toBe(true);
    expect(res.content).toContain("exit 3");
  });

  it("cwd 默认工作区根，命令在其中执行", async () => {
    const r = freshRoot();
    fs.writeFileSync(path.join(r, "marker.txt"), "x");
    const res = await run({ command: "ls" }, ctxFor(r));
    expect(res.content).toContain("marker.txt");
  });

  it("超时杀进程", async () => {
    const r = freshRoot();
    const res = await run({ command: "sleep 5", timeout_ms: 150 }, ctxFor(r));
    expect(res.isError).toBe(true);
    expect(res.content).toContain("超时");
  });

  it("abort 中断", async () => {
    const r = freshRoot();
    const ac = new AbortController();
    const p = run({ command: "sleep 5" }, ctxFor(r, { signal: ac.signal }));
    setTimeout(() => ac.abort(), 100);
    const res = await p;
    expect(res.isError).toBe(true);
  });

  it("流式 emit 收到 stdout chunk", async () => {
    const r = freshRoot();
    const events: AgentEvent[] = [];
    const res = await run(
      { command: "echo streamed" },
      ctxFor(r, { emit: (e) => events.push(e as unknown as AgentEvent) }),
    );
    expect(res.isError).toBeFalsy();
    const progress = events.filter((e) => e.type === "tool-progress");
    expect(progress.length).toBeGreaterThan(0);
    expect((progress[0] as { chunk: string }).chunk).toContain("streamed");
  });

  it("cwd 越界被拒绝", async () => {
    const r = freshRoot();
    const res = await run({ command: "echo x", cwd: "../.." }, ctxFor(r));
    expect(res.isError).toBe(true);
    expect(res.content).toContain("越界");
  });

  it("findGitBash：非 Windows 恒为 null", () => {
    // 本机非 Windows → null；Windows 下取决于是否装了 Git for Windows。
    if (process.platform !== "win32") expect(findGitBash()).toBeNull();
    else expect(findGitBash() === null || typeof findGitBash() === "string").toBe(true);
  });
});
