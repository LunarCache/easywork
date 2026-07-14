import fs from "node:fs";
import path from "node:path";
import type { TurnArtifact } from "@ew/shared";

export interface TurnFileStamp {
  size: number;
  mtimeMs: number;
}

export type TurnFileSnapshot = Map<string, TurnFileStamp>;

const EXCLUDED_DIRS = new Set([".git", ".turbo", ".cache", "node_modules"]);
const MAX_FILES = 5_000;
const MAX_DEPTH = 12;

/**
 * 对话工件目录的轻量清单。跳过依赖/缓存树和 symlink，避免命令产物把扫描带出会话目录。
 * 只记录 size + mtime；真正需要预览时仍走现有受限文件 API。
 */
export function snapshotTurnFiles(root: string): TurnFileSnapshot {
  const snapshot: TurnFileSnapshot = new Map();
  const visit = (absoluteDir: string, relativeDir: string, depth: number) => {
    if (depth > MAX_DEPTH || snapshot.size >= MAX_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absoluteDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (snapshot.size >= MAX_FILES) break;
      if (entry.isSymbolicLink()) continue;
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      const absolutePath = path.join(absoluteDir, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) visit(absolutePath, relativePath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = fs.statSync(absolutePath);
        snapshot.set(relativePath, { size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        /* 文件在扫描中消失：忽略。 */
      }
    }
  };
  visit(root, "", 0);
  return snapshot;
}

/** 只返回轮次结束时仍存在的新增/修改文件；删除文件不是“交付物”。 */
export function diffTurnFiles(before: TurnFileSnapshot, after: TurnFileSnapshot): TurnArtifact[] {
  const artifacts: TurnArtifact[] = [];
  for (const [path, current] of after) {
    const previous = before.get(path);
    if (!previous) artifacts.push({ path, kind: "created", size: current.size });
    else if (previous.size !== current.size || previous.mtimeMs !== current.mtimeMs)
      artifacts.push({ path, kind: "modified", size: current.size });
  }
  return artifacts.sort((a, b) => a.path.localeCompare(b.path));
}
