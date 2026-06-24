// 统一文件预览的前端辅助：复用 shared 的类型判定 + 带鉴权的 blob URL hook。
import { useEffect, useState } from "react";
export { resolvePreviewKind, mimeForName, extOf } from "@ew/shared";
export type { PreviewKind, PreviewMeta } from "@ew/shared";

/** 扩展名 → highlight.js 语言（代码预览用；未知返回 undefined 走 auto）。 */
const LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", pyi: "python", rs: "rust", go: "go", java: "java", kt: "kotlin",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", rb: "ruby", php: "php",
  swift: "swift", lua: "lua", css: "css", scss: "scss", less: "less",
  json: "json", jsonc: "json", json5: "json", yaml: "yaml", yml: "yaml",
  toml: "ini", ini: "ini", xml: "xml", html: "xml", htm: "xml", vue: "xml", svelte: "xml",
  sql: "sql", sh: "bash", bash: "bash", zsh: "bash", fish: "bash", ps1: "powershell", md: "markdown",
};
export function langForExt(ext: string): string | undefined {
  return LANG[ext];
}

/**
 * 带鉴权的 blob URL：用稳定的 key 触发，fetcher 返回 Blob → createObjectURL，卸载/换 key 时 revoke。
 * key 为 null 时不取（用于非媒体类）。
 */
export function useBlobUrl(
  key: string | null,
  fetcher: () => Promise<Blob>,
): { url: string | null; loading: boolean; error: boolean } {
  const [state, setState] = useState<{ url: string | null; loading: boolean; error: boolean }>({
    url: null,
    loading: !!key,
    error: false,
  });
  useEffect(() => {
    if (!key) {
      setState({ url: null, loading: false, error: false });
      return;
    }
    let revoked = false;
    let made: string | null = null;
    setState({ url: null, loading: true, error: false });
    fetcher()
      .then((blob) => {
        if (revoked) return;
        made = URL.createObjectURL(blob);
        setState({ url: made, loading: false, error: false });
      })
      .catch(() => {
        if (!revoked) setState({ url: null, loading: false, error: true });
      });
    return () => {
      revoked = true;
      if (made) URL.revokeObjectURL(made);
    };
    // fetcher 仅在 key 变化时调用；key 已编码 scope/id/path，故不进依赖。
  }, [key]);
  return state;
}
