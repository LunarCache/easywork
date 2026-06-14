import fs from "node:fs";
import path from "node:path";

/**
 * 工作区路径沙箱（仿 ssrf.ts 的"抛错=拒绝"约定）。
 * 把用户/模型给的相对或绝对路径解析为工作区根内的绝对路径，越界即抛错。
 * 防护：`..` 越界、绝对路径逃逸、符号链接逃逸（对已存在前缀做 realpath 再校验）。
 */
export function resolveWorkspacePath(root: string, userPath: string): string {
  if (typeof userPath !== "string") throw new Error("路径必须是字符串");
  // 规范化根自身（解析根的符号链接），作为越界判定的基准。
  const realRoot = safeRealpath(root);
  const resolved = path.resolve(realRoot, userPath);
  assertInsideWorkspace(realRoot, resolved);

  // 符号链接逃逸：对 resolved 的最深「已存在前缀」做 realpath，再次校验仍在根内。
  // （写新文件时 resolved 不存在，则校验其已存在的父目录。）
  const existing = deepestExisting(resolved);
  if (existing) {
    const realExisting = safeRealpath(existing);
    assertInsideWorkspace(realRoot, realExisting);
  }
  return resolved;
}

/** 断言 target 在 root 内（root 自身或其子路径），否则抛错。两者都应已规范化。 */
export function assertInsideWorkspace(root: string, target: string): void {
  if (target === root) return;
  if (target.startsWith(root + path.sep)) return;
  throw new Error(`路径越界（超出工作区）: ${target}`);
}

/** realpath；路径不存在时回退为 path.resolve（不抛）。 */
function safeRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** 返回 p 自身或其最深的已存在祖先目录；都不存在返回 null。 */
function deepestExisting(p: string): string | null {
  let cur = p;
  // 最多上溯到文件系统根，避免死循环。
  for (let i = 0; i < 4096; i++) {
    if (fs.existsSync(cur)) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}
