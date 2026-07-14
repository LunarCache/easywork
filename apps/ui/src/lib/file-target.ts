import type { WsEntry } from "@ew/sdk";

function normalizeFilePath(value: string): string {
  return value.replace(/\\/g, "/");
}

/**
 * 把消息里的绝对/相对目标路径解析到文件列表条目。
 * 优先精确路径，其次最长且唯一的路径后缀，最后才接受唯一 basename。
 */
export function matchFileTarget(files: WsEntry[], target: string): WsEntry | undefined {
  const want = normalizeFilePath(target);
  const normalized = files.map((file) => ({ file, path: normalizeFilePath(file.path) }));
  const exact = normalized.find((candidate) => candidate.path === want);
  if (exact) return exact.file;

  const suffixMatches = normalized.filter((candidate) => want.endsWith(`/${candidate.path}`));
  if (suffixMatches.length > 0) {
    const longestLength = Math.max(...suffixMatches.map((candidate) => candidate.path.length));
    const longest = suffixMatches.filter((candidate) => candidate.path.length === longestLength);
    if (longest.length === 1) return longest[0]!.file;
  }

  const base = want.split("/").pop();
  const basenameMatches = normalized.filter((candidate) => candidate.path.split("/").pop() === base);
  return basenameMatches.length === 1 ? basenameMatches[0]!.file : undefined;
}
