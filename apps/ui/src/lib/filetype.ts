// 统一文件类型图标体系：扩展名 → { 角标文字, 品牌色, lucide 图标 }。
// 全应用共用（工具行编辑角标 / 文件树 / 工件列表），避免各处各搞一套。
import {
  FileIcon,
  FileCodeIcon,
  FileJsonIcon,
  FileSpreadsheetIcon,
  FileImageIcon,
  FileTerminalIcon,
} from "../icons.js";

export interface FileTypeInfo {
  /** 彩色方角标里的短文字（≤4 字符）。 */
  label: string;
  /** 品牌色（角标底色 / 图标着色）。 */
  color: string;
  /** 列表 / 文件树用的 lucide 图标。 */
  Icon: typeof FileIcon;
}

interface Spec extends FileTypeInfo {
  exts: string[];
}

// 顺序无关；按类别归组，便于维护。
const SPECS: Spec[] = [
  // —— 代码 ——
  { label: "TS", color: "#3178C6", Icon: FileCodeIcon, exts: ["ts", "tsx", "mts", "cts"] },
  { label: "JS", color: "#E3B341", Icon: FileCodeIcon, exts: ["js", "jsx", "mjs", "cjs"] },
  { label: "PY", color: "#3776AB", Icon: FileCodeIcon, exts: ["py", "pyi", "pyw"] },
  { label: "RS", color: "#E0524F", Icon: FileCodeIcon, exts: ["rs"] },
  { label: "GO", color: "#00ADD8", Icon: FileCodeIcon, exts: ["go"] },
  { label: "JV", color: "#E76F00", Icon: FileCodeIcon, exts: ["java", "kt", "kts"] },
  { label: "C", color: "#5C6BC0", Icon: FileCodeIcon, exts: ["c", "h"] },
  { label: "C++", color: "#5C6BC0", Icon: FileCodeIcon, exts: ["cpp", "cc", "cxx", "hpp"] },
  { label: "RB", color: "#CC342D", Icon: FileCodeIcon, exts: ["rb"] },
  { label: "PHP", color: "#777BB4", Icon: FileCodeIcon, exts: ["php"] },
  { label: "SW", color: "#F05138", Icon: FileCodeIcon, exts: ["swift"] },
  { label: "LUA", color: "#000080", Icon: FileCodeIcon, exts: ["lua"] },
  // —— Web ——
  { label: "<>", color: "#E8662A", Icon: FileCodeIcon, exts: ["html", "htm"] },
  { label: "#", color: "#519ABA", Icon: FileCodeIcon, exts: ["css"] },
  { label: "#", color: "#CD6799", Icon: FileCodeIcon, exts: ["scss", "sass", "less"] },
  { label: "VUE", color: "#41B883", Icon: FileCodeIcon, exts: ["vue", "svelte"] },
  // —— 数据 / 配置 ——
  { label: "{}", color: "#B5640A", Icon: FileJsonIcon, exts: ["json", "jsonc", "json5"] },
  { label: "YML", color: "#A0427A", Icon: FileCodeIcon, exts: ["yaml", "yml"] },
  { label: "TOML", color: "#9C4221", Icon: FileCodeIcon, exts: ["toml", "ini", "cfg", "conf", "env"] },
  { label: "XML", color: "#E37933", Icon: FileCodeIcon, exts: ["xml"] },
  { label: "SQL", color: "#336791", Icon: FileCodeIcon, exts: ["sql"] },
  { label: "SH", color: "#4EAA25", Icon: FileTerminalIcon, exts: ["sh", "bash", "zsh", "fish", "ps1"] },
  // —— 文档 ——
  { label: "MD", color: "#3B6FE0", Icon: FileIcon, exts: ["md", "markdown", "mdx"] },
  { label: "TXT", color: "#8A919C", Icon: FileIcon, exts: ["txt", "log", "text"] },
  { label: "PDF", color: "#E0524F", Icon: FileIcon, exts: ["pdf"] },
  { label: "DOC", color: "#2B579A", Icon: FileIcon, exts: ["doc", "docx", "rtf", "odt"] },
  { label: "XLS", color: "#1E9E58", Icon: FileSpreadsheetIcon, exts: ["xls", "xlsx", "ods"] },
  { label: "CSV", color: "#1E9E58", Icon: FileSpreadsheetIcon, exts: ["csv", "tsv"] },
  { label: "PPT", color: "#D24726", Icon: FileIcon, exts: ["ppt", "pptx", "odp", "key"] },
  // —— 资源 ——
  { label: "IMG", color: "#A06CF5", Icon: FileImageIcon, exts: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"] },
  { label: "ZIP", color: "#B08C00", Icon: FileIcon, exts: ["zip", "tar", "gz", "tgz", "rar", "7z"] },
];

const BY_EXT: Record<string, FileTypeInfo> = {};
for (const s of SPECS) {
  const info: FileTypeInfo = { label: s.label, color: s.color, Icon: s.Icon };
  for (const e of s.exts) BY_EXT[e] = info;
}

const FALLBACK_COLOR = "#6B7280";

// 整名匹配（dotfile / 无扩展名配置文件）：不能按「最后一个点后」当扩展名，否则 .gitignore → "GITI"。
const BY_NAME: Record<string, FileTypeInfo> = {
  dockerfile: { label: "DOCK", color: "#2496ED", Icon: FileCodeIcon },
  ".dockerignore": { label: "DOCK", color: "#2496ED", Icon: FileIcon },
  makefile: { label: "MK", color: "#4EAA25", Icon: FileTerminalIcon },
  ".gitignore": { label: "GIT", color: "#F05133", Icon: FileIcon },
  ".gitattributes": { label: "GIT", color: "#F05133", Icon: FileIcon },
  ".npmrc": { label: "NPM", color: "#CB3837", Icon: FileIcon },
  license: { label: "LIC", color: "#8A919C", Icon: FileIcon },
};

/** 解析文件路径 → 文件类型信息（未知扩展名回退到大写扩展名 + 通用文件图标）。 */
export function fileType(path: string): FileTypeInfo {
  const name = path.split(/[/\\]/).pop() || path;
  const lower = name.toLowerCase();
  if (BY_NAME[lower]) return BY_NAME[lower];
  if (lower === ".env" || lower.startsWith(".env.")) return { label: "ENV", color: "#9C4221", Icon: FileCodeIcon };
  // dotfile（.bashrc）或无扩展名（Makefile）：name 里没有「非首位的点」→ 不当扩展名处理，回退通用文件。
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return { label: "FILE", color: FALLBACK_COLOR, Icon: FileIcon };
  const ext = name.slice(dot + 1).toLowerCase();
  return BY_EXT[ext] ?? { label: ext.slice(0, 4).toUpperCase() || "FILE", color: FALLBACK_COLOR, Icon: FileIcon };
}
