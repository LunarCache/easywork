/** 上传文件解析为纯文本。支持常见文本/标记/代码格式；二进制（PDF/docx 等）暂不支持。 */

const TEXT_EXT = new Set([
  "txt",
  "text",
  "md",
  "markdown",
  "mdx",
  "rst",
  "org",
  "csv",
  "tsv",
  "json",
  "jsonl",
  "ndjson",
  "log",
  "yaml",
  "yml",
  "xml",
  "ini",
  "conf",
  "toml",
  "js",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "jsx",
  "py",
  "go",
  "rs",
  "java",
  "kt",
  "c",
  "cc",
  "cpp",
  "h",
  "hpp",
  "cs",
  "rb",
  "php",
  "sh",
  "bash",
  "sql",
  "vue",
  "svelte",
]);

function extOf(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m ? m[1]!.toLowerCase() : "";
}

/** 粗略判断是否为二进制（前若干字节含较多 NUL）。 */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 4096);
  if (n === 0) return false;
  let nul = 0;
  for (let i = 0; i < n; i++) if (buf[i] === 0) nul++;
  return nul / n > 0.005;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/** 解析文件字节为文本。无法识别/二进制时抛出可读错误。 */
export function parseFile(filename: string, buf: Buffer): string {
  const ext = extOf(filename);
  if (ext === "html" || ext === "htm") return stripHtml(buf.toString("utf8"));
  if (ext === "pdf") throw new Error("PDF 暂不支持，请转为 txt/md 或直接粘贴文本");
  if (["docx", "doc", "xlsx", "pptx", "zip", "png", "jpg", "jpeg", "gif"].includes(ext)) {
    throw new Error(`不支持的文件类型 .${ext}（请上传文本/markdown 文件，或粘贴文本）`);
  }
  if (TEXT_EXT.has(ext) || (!ext && !looksBinary(buf))) {
    if (looksBinary(buf)) throw new Error("疑似二进制文件，无法解析为文本");
    return buf.toString("utf8");
  }
  throw new Error(`不支持的文件类型 .${ext || "?"}（请上传文本/markdown 文件，或粘贴文本）`);
}
