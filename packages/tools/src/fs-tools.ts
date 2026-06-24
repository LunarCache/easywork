import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ApprovalPolicy, Tool } from "@ew/shared";
import { defineTool } from "./define.js";
import { resolveWorkspacePath } from "./path-sandbox.js";

const MAX_READ_BYTES = 256 * 1024;
const MAX_GREP_MATCHES = 200;
const MAX_LIST_ENTRIES = 800;
const IGNORE_DIRS = new Set([".git", "node_modules", ".turbo", "dist", ".next", ".cache"]);

interface FsEntry {
  path: string; // 相对工作区根
  type: "file" | "dir";
  size?: number;
}

/** 嗅探二进制：前 8KB 含 NUL 字节即判二进制。 */
function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** 纯函数：列目录树（供工具与 HTTP 端点共用）。relPath 相对根；depth>=1。 */
export function listDir(root: string, relPath = ".", depth = 1): FsEntry[] {
  const base = resolveWorkspacePath(root, relPath);
  // 相对路径基准用规范化后的根（与 resolveWorkspacePath 一致），否则根在符号链接下时 path.relative 产出越界路径。
  let realRoot = root;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    /* 不存在则保持原值 */
  }
  const out: FsEntry[] = [];
  const walk = (abs: string, d: number): void => {
    if (out.length >= MAX_LIST_ENTRIES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => {
      const ad = a.isDirectory() ? 0 : 1;
      const bd = b.isDirectory() ? 0 : 1;
      return ad !== bd ? ad - bd : a.name.localeCompare(b.name);
    });
    for (const e of entries) {
      if (out.length >= MAX_LIST_ENTRIES) return;
      if (e.name.startsWith(".") && IGNORE_DIRS.has(e.name)) continue;
      if (e.isDirectory() && IGNORE_DIRS.has(e.name)) continue;
      const absChild = path.join(abs, e.name);
      const rel = path.relative(realRoot, absChild);
      if (e.isDirectory()) {
        out.push({ path: rel, type: "dir" });
        if (d > 1) walk(absChild, d - 1);
      } else if (e.isFile()) {
        let size = 0;
        try {
          size = fs.statSync(absChild).size;
        } catch {
          /* ignore */
        }
        out.push({ path: rel, type: "file", size });
      }
    }
  };
  walk(base, depth);
  return out;
}

export interface ReadResult {
  content?: string;
  binary?: boolean;
  tooLarge?: boolean;
  truncated?: boolean;
  size: number;
}

/** 纯函数：安全读文件（供工具与 HTTP 端点共用）。可选行范围 [start,end]（1-based，含端点）。 */
export function readFileSafe(
  root: string,
  relPath: string,
  range?: { start?: number; end?: number },
): ReadResult {
  const abs = resolveWorkspacePath(root, relPath);
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) throw new Error("目标是目录，请用 fs_list");
  const buf = fs.readFileSync(abs);
  if (isBinary(buf)) return { binary: true, size: stat.size };
  let text = buf.toString("utf8");
  let truncated = false;
  if (range?.start != null || range?.end != null) {
    const lines = text.split("\n");
    const start = Math.max(1, range.start ?? 1);
    const end = Math.min(lines.length, range.end ?? lines.length);
    text = lines.slice(start - 1, end).join("\n");
  }
  // 字节上限对所有路径生效（含行范围），防止超大文件/超大行范围灌爆上下文。
  if (text.length > MAX_READ_BYTES) {
    text = text.slice(0, MAX_READ_BYTES);
    truncated = true;
  }
  return { content: text, truncated, size: stat.size };
}

const MAX_RAW_BYTES = 12 * 1024 * 1024; // 12MB：图片/PDF/SVG 足够；blob 整文件进内存，超限只取前缀并标记。

export interface RawResult {
  buffer: Buffer;
  size: number;
  truncated: boolean;
}

/** 纯函数：安全读"原始字节"（供 /files/raw 端点给 img/pdf 用 blob 渲染）。路径经 resolveWorkspacePath 限定。 */
export function readRawSafe(root: string, relPath: string, maxBytes = MAX_RAW_BYTES): RawResult {
  const abs = resolveWorkspacePath(root, relPath);
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) throw new Error("目标是目录，无法预览");
  if (stat.size > maxBytes) {
    const fd = fs.openSync(abs, "r");
    try {
      const buffer = Buffer.alloc(maxBytes);
      const n = fs.readSync(fd, buffer, 0, maxBytes, 0);
      return { buffer: buffer.subarray(0, n), size: stat.size, truncated: true };
    } finally {
      fs.closeSync(fd);
    }
  }
  return { buffer: fs.readFileSync(abs), size: stat.size, truncated: false };
}

/** 纯函数：安全取文件大小（媒体类预览 meta 用，不读全文）。路径经 resolveWorkspacePath 限定。 */
export function statFileSafe(root: string, relPath: string): { size: number } {
  const abs = resolveWorkspacePath(root, relPath);
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) throw new Error("目标是目录，无法预览");
  return { size: stat.size };
}

/** 带行号渲染（cat -n 风格，便于模型按行定位）。 */
function withLineNumbers(text: string, startLine = 1): string {
  return text
    .split("\n")
    .map((l, i) => `${String(startLine + i).padStart(5)}\t${l}`)
    .join("\n");
}

/** fs_write/fs_edit 的 UI 载荷。改动审阅由右侧 git 面板负责，这里只标记改了哪个文件。 */
function diffDisplay(file: string, before: string | null, after: string): Record<string, unknown> {
  return { kind: "diff", path: file, before, after };
}

function err(content: string): { content: string; isError: true } {
  return { content, isError: true };
}

/** 构造工作区 fs 工具族。writeApproval 控制写工具审批；includeWrite=false 时不暴露写工具（read-only 模式）。 */
export function makeFsTools(opts?: { writeApproval?: ApprovalPolicy; includeWrite?: boolean }): Tool[] {
  const writeApproval = opts?.writeApproval ?? "always";
  const includeWrite = opts?.includeWrite ?? true;

  const fsList = defineTool({
    name: "fs_list",
    description: "列出工作区内目录的文件/子目录（树）。跳过 .git/node_modules 等。",
    schema: z.object({
      path: z.string().optional().describe("相对工作区的目录，默认根"),
      depth: z.number().int().min(1).max(5).optional().describe("递归层数，默认 1"),
    }),
    requiresApproval: "never",
    run({ path: p, depth }, ctx) {
      try {
        const entries = listDir(ctx.workspaceDir, p ?? ".", depth ?? 1);
        const text = entries.map((e) => `${e.type === "dir" ? "📁" : "📄"} ${e.path}`).join("\n");
        return {
          content: entries.length ? text : "（空目录）",
          display: { kind: "fs_list", entries },
        };
      } catch (e) {
        return err(msg(e));
      }
    },
  });

  const fsRead = defineTool({
    name: "fs_read",
    description: "读取工作区内的文本文件（可选行范围）。返回带行号内容。",
    schema: z.object({
      path: z.string().describe("相对工作区的文件路径"),
      start_line: z.number().int().positive().optional(),
      end_line: z.number().int().positive().optional(),
    }),
    requiresApproval: "never",
    run({ path: p, start_line, end_line }, ctx) {
      try {
        const r = readFileSafe(ctx.workspaceDir, p, { start: start_line, end: end_line });
        if (r.binary) return err(`二进制文件，无法读取：${p}`);
        const numbered = withLineNumbers(r.content ?? "", start_line ?? 1);
        const note = r.truncated ? `\n…（已截断，文件 ${r.size} 字节，请用行范围读取剩余部分）` : "";
        return { content: numbered + note };
      } catch (e) {
        return err(msg(e));
      }
    },
  });

  const fsGrep = defineTool({
    name: "fs_grep",
    description: "在工作区内按正则搜索文件内容，返回 path:line:文本。",
    schema: z.object({
      pattern: z.string().describe("正则表达式"),
      path: z.string().optional().describe("搜索目录，默认根"),
      max_results: z.number().int().positive().optional(),
    }),
    requiresApproval: "never",
    run({ pattern, path: p, max_results }, ctx) {
      let re: RegExp;
      try {
        re = new RegExp(pattern);
      } catch (e) {
        return err(`非法正则：${msg(e)}`);
      }
      try {
        const cap = Math.min(max_results ?? MAX_GREP_MATCHES, MAX_GREP_MATCHES);
        const hits: { path: string; line: number; text: string }[] = [];
        const files = listDir(ctx.workspaceDir, p ?? ".", 5).filter((e) => e.type === "file");
        for (const f of files) {
          if (hits.length >= cap) break;
          let buf: Buffer;
          try {
            buf = fs.readFileSync(resolveAbs(ctx.workspaceDir, f.path));
          } catch {
            continue;
          }
          if (isBinary(buf)) continue;
          const lines = buf.toString("utf8").split("\n");
          for (let i = 0; i < lines.length && hits.length < cap; i++) {
            if (re.test(lines[i]!)) hits.push({ path: f.path, line: i + 1, text: lines[i]!.slice(0, 300) });
          }
        }
        const text = hits.length
          ? hits.map((h) => `${h.path}:${h.line}: ${h.text}`).join("\n")
          : "未找到匹配。";
        return { content: text, display: { kind: "fs_grep", hits } };
      } catch (e) {
        return err(msg(e));
      }
    },
  });

  const readonly = [fsList, fsRead, fsGrep];
  if (!includeWrite) return readonly;

  const fsWrite = defineTool({
    name: "fs_write",
    description: "在工作区内写入文件（新建或整体覆盖）。",
    schema: z.object({
      path: z.string().describe("相对工作区的文件路径"),
      content: z.string().describe("完整文件内容"),
    }),
    requiresApproval: writeApproval,
    run({ path: p, content }, ctx) {
      try {
        const abs = resolveWorkspacePath(ctx.workspaceDir, p);
        let before: string | null = null;
        try {
          const b = fs.readFileSync(abs);
          before = isBinary(b) ? null : b.toString("utf8");
        } catch {
          before = null;
        }
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, "utf8");
        const lines = content.split("\n").length;
        return {
          content: `已写入 ${p}（${lines} 行）。`,
          display: diffDisplay(p, before, content),
        };
      } catch (e) {
        return err(msg(e));
      }
    },
  });

  const fsEdit = defineTool({
    name: "fs_edit",
    description:
      "编辑工作区内已有文件：用 old_string 唯一定位并替换为 new_string（replace_all 可全替）。",
    schema: z.object({
      path: z.string().describe("相对工作区的文件路径"),
      old_string: z.string().describe("要替换的原文（需在文件中唯一，除非 replace_all）"),
      new_string: z.string().describe("替换后的内容"),
      replace_all: z.boolean().optional(),
    }),
    requiresApproval: writeApproval,
    run({ path: p, old_string, new_string, replace_all }, ctx) {
      try {
        const abs = resolveWorkspacePath(ctx.workspaceDir, p);
        const buf = fs.readFileSync(abs);
        if (isBinary(buf)) return err(`二进制文件，无法编辑：${p}`);
        const before = buf.toString("utf8");
        if (!before.includes(old_string)) return err(`未找到 old_string，无法定位：${p}`);
        const count = before.split(old_string).length - 1;
        if (count > 1 && !replace_all)
          return err(`old_string 在 ${p} 中出现 ${count} 次，请提供更精确的上下文或设 replace_all。`);
        const after = replace_all
          ? before.split(old_string).join(new_string)
          : before.replace(old_string, new_string);
        fs.writeFileSync(abs, after, "utf8");
        return { content: `已编辑 ${p}（替换 ${replace_all ? count : 1} 处）。`, display: diffDisplay(p, before, after) };
      } catch (e) {
        return err(msg(e));
      }
    },
  });

  return [...readonly, fsWrite, fsEdit];
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
function resolveAbs(root: string, rel: string): string {
  return resolveWorkspacePath(root, rel);
}
