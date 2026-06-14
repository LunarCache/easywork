import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ApprovalPolicy, Tool, ToolExecContext } from "@ew/shared";
import { defineTool } from "./define.js";
import { resolveWorkspacePath } from "./path-sandbox.js";

const DEFAULT_TIMEOUT = 120_000;
const MAX_TIMEOUT = 600_000;
const MAX_OUTPUT = 100 * 1024; // 每路 stdout/stderr 上限
const IS_WIN = process.platform === "win32";

/**
 * Windows 下定位 Git for Windows 自带的 bash.exe（含 ls/cat/rm/grep 等 Unix 工具）。
 * 优先 env EW_GIT_BASH；否则探常见安装路径。找不到返回 null（回退 cmd.exe）。
 */
export function findGitBash(): string | null {
  if (!IS_WIN) return null;
  const candidates: string[] = [];
  if (process.env.EW_GIT_BASH) candidates.push(process.env.EW_GIT_BASH);
  const bases = [
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs") : undefined,
  ].filter((b): b is string => !!b);
  for (const base of bases) {
    candidates.push(path.join(base, "Git", "bin", "bash.exe"));
    candidates.push(path.join(base, "Git", "usr", "bin", "bash.exe"));
  }
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** 在工作区根内执行 shell 命令，流式输出经 ctx.emit 发 tool-progress。 */
export function makeExecTool(opts?: { approval?: ApprovalPolicy }): Tool {
  return defineTool({
    name: "run_command",
    description:
      "在工作区目录内执行 shell 命令（如 build/test/git）。cwd 限定在工作区内；输出流式返回。",
    schema: z.object({
      command: z.string().describe("要执行的 shell 命令"),
      cwd: z.string().optional().describe("相对工作区的子目录，默认工作区根"),
      timeout_ms: z.number().int().positive().max(MAX_TIMEOUT).optional(),
    }),
    requiresApproval: opts?.approval ?? "always",
    async run({ command, cwd, timeout_ms }, ctx: ToolExecContext) {
      let workdir: string;
      try {
        workdir = resolveWorkspacePath(ctx.workspaceDir, cwd ?? ".");
      } catch (e) {
        return { content: e instanceof Error ? e.message : String(e), isError: true };
      }
      // 用工具调用 id 标记 tool-progress，使 UI 工具卡能对齐流式输出。
      const callId = ctx.callId ?? `exec-${Date.now().toString(36)}`;
      const timeout = timeout_ms ?? DEFAULT_TIMEOUT;

      return await new Promise((resolve) => {
        let stdout = "";
        let stderr = "";
        let stdoutTrunc = false;
        let stderrTrunc = false;
        let settled = false;

        // Windows：用 Git for Windows 的 bash 作 shell（让模型生成的 Unix 命令可用），找不到回退 cmd。
        // 非 Windows：用 /bin/sh，detached 使子进程自成进程组以便杀整棵树。
        const winBash = IS_WIN ? findGitBash() : null;
        const child = spawn(command, {
          cwd: workdir,
          shell: winBash ?? true,
          ...(IS_WIN ? {} : { detached: true }),
          env: process.env,
        });

        const killTree = (): void => {
          if (IS_WIN && child.pid) {
            // Windows 无 POSIX 进程组：taskkill /T 连子孙进程一起杀。
            try {
              spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
              return;
            } catch {
              /* fall through */
            }
          }
          try {
            if (!IS_WIN && child.pid) process.kill(-child.pid, "SIGKILL"); // 负 pid = 杀整个进程组
            else child.kill("SIGKILL");
          } catch {
            try {
              child.kill();
            } catch {
              /* already gone */
            }
          }
        };
        const onAbort = (): void => {
          if (!settled) {
            killTree();
            finish(null, false, true);
          }
        };
        ctx.signal.addEventListener("abort", onAbort, { once: true });

        const append = (stream: "stdout" | "stderr", chunk: string): void => {
          if (stream === "stdout") {
            if (stdout.length < MAX_OUTPUT) stdout += chunk;
            else stdoutTrunc = true;
          } else {
            if (stderr.length < MAX_OUTPUT) stderr += chunk;
            else stderrTrunc = true;
          }
          ctx.emit?.({ type: "tool-progress", callId, stream, chunk });
        };

        const timer = setTimeout(() => {
          if (!settled) {
            killTree();
            finish(null, true);
          }
        }, timeout);

        child.stdout?.on("data", (d: Buffer) => append("stdout", d.toString("utf8")));
        child.stderr?.on("data", (d: Buffer) => append("stderr", d.toString("utf8")));

        const finish = (code: number | null, timedOut = false, aborted = false): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          ctx.signal.removeEventListener("abort", onAbort);
          if (aborted) {
            resolve({ content: "[已中断]", isError: true, display: { kind: "exec", callId, command, exitCode: null, timedOut: false } });
            return;
          }
          const parts: string[] = [];
          if (timedOut) parts.push(`[超时 ${timeout}ms，已终止]`);
          parts.push(`[exit ${code ?? "killed"}]`);
          if (stdout) parts.push(stdout + (stdoutTrunc ? "\n…（stdout 已截断）" : ""));
          if (stderr) parts.push("[stderr]\n" + stderr + (stderrTrunc ? "\n…（stderr 已截断）" : ""));
          resolve({
            content: parts.join("\n"),
            isError: timedOut || (code != null && code !== 0),
            display: { kind: "exec", callId, command, exitCode: code, timedOut },
          });
        };

        child.on("error", (e) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ content: `命令执行失败：${e.message}`, isError: true });
        });
        child.on("close", (code) => finish(code));
      });
    },
  });
}
