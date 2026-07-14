/**
 * 统一文件预览契约：渲染类型 + 元信息。供 dock 文件预览与工件共用。
 * 设计：一个 `resolvePreviewKind` 判定渲染类型（前后端共用），媒体/二进制走 /files/raw 取字节，
 * 文本类直接内联文本。前端按 kind 选渲染器（开闭：加类型 = 加一个渲染分支）。
 */

export type PreviewKind = "text" | "code" | "markdown" | "image" | "svg" | "pdf" | "html" | "binary";

export interface PreviewMeta {
  name: string;
  mime: string;
  kind: PreviewKind;
  size: number;
  /** 文本类（text/code/markdown/svg/html）内联返回；image/pdf/binary 不内联（前端取字节）。 */
  text?: string;
  truncated?: boolean;
}

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "ico", "avif", "bmp"]);
const CODE_EXT = new Set([
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "py", "pyi", "pyw", "rs", "go", "java", "kt", "kts",
  "c", "h", "cpp", "cc", "cxx", "hpp", "rb", "php", "swift", "lua", "css", "scss", "sass", "less", "vue",
  "svelte", "json", "jsonc", "json5", "yaml", "yml", "toml", "ini", "cfg", "conf", "xml", "sql",
  "sh", "bash", "zsh", "fish", "ps1", "dockerfile", "makefile",
]);

const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  ico: "image/x-icon", avif: "image/avif", bmp: "image/bmp", svg: "image/svg+xml",
  pdf: "application/pdf", html: "text/html", htm: "text/html",
  json: "application/json", js: "text/javascript", css: "text/css", md: "text/markdown", txt: "text/plain",
};

/** 取文件名的小写扩展名（无扩展名返回 ""）。 */
export function extOf(name: string): string {
  const base = name.split(/[/\\]/).pop() || name;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

export function mimeForName(name: string): string {
  return MIME[extOf(name)] ?? "application/octet-stream";
}

/** 按文件名解析渲染类型（不嗅探内容；服务端可用 binary 嗅探把文本类覆盖为 "binary"）。 */
export function resolvePreviewKind(name: string): PreviewKind {
  const e = extOf(name);
  if (e === "md" || e === "markdown" || e === "mdx") return "markdown";
  if (e === "html" || e === "htm") return "html";
  if (e === "svg") return "svg";
  if (e === "pdf") return "pdf";
  if (IMAGE_EXT.has(e)) return "image";
  if (CODE_EXT.has(e)) return "code";
  return "text"; // 默认按文本（含无扩展名）；服务端若嗅探到二进制会覆盖为 binary
}
