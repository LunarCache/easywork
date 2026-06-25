import { isValidElement, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import hljs from "highlight.js/lib/common";
import { splitThink, type UiBlock, type UiMsg, type UiTool } from "../lib/agent-stream.js";
import { fileType } from "../lib/filetype.js";
import {
  BrainIcon,
  ChevronIcon,
  ClockIcon,
  SearchIcon,
  GlobeIcon,
  WrenchIcon,
  SquareTerminalIcon,
  EditIcon,
  FileIcon,
  CodeIcon,
  SparkIcon,
  CopyIcon,
  CheckIcon,
  RefreshIcon,
} from "../icons.js";

function fmtTime(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

/** 本轮耗时 → 「已工作 N 分 M 秒」（<60s 只显秒）。 */
function fmtWork(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `已工作 ${s} 秒`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `已工作 ${m} 分 ${r} 秒` : `已工作 ${m} 分`;
}

function host(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
function toolQuery(args: string): string {
  try {
    const a = JSON.parse(args || "{}") as { query?: string; url?: string };
    return a.query || a.url || "";
  } catch {
    return "";
  }
}
function toolSubject(args: string): string {
  try {
    const a = JSON.parse(args || "{}") as { command?: string; path?: string; file_path?: string };
    return a.command || a.path || a.file_path || "";
  } catch {
    return "";
  }
}

export function CopyButton({
  text,
  className = "msg-action",
  label,
}: {
  text: string;
  className?: string;
  /** 提供则按钮带文字（复制后短暂变「已复制」）。 */
  label?: string;
}) {
  const [done, setDone] = useState(false);
  return (
    <button
      className={className}
      title="复制"
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    >
      {done ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
      {label && <span>{done ? "已复制" : label}</span>}
    </button>
  );
}

/** 递归取 React 子树纯文本（highlight.js 高亮后代码是 span 树，取其文本作复制源）。 */
function codeText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(codeText).join("");
  if (isValidElement(node)) return codeText((node.props as { children?: ReactNode }).children);
  return "";
}

/** markdown 代码块（react-markdown 的 `pre` 覆写）：顶栏显示语言 + 复制按钮。内联代码不受影响。 */
function CodeBlock({ children }: { children?: ReactNode }) {
  const codeEl = Array.isArray(children) ? children.find(isValidElement) : children;
  const className = isValidElement(codeEl) ? ((codeEl.props as { className?: string }).className ?? "") : "";
  const lang = /language-([\w-]+)/.exec(className)?.[1] ?? "";
  const raw = codeText(children).replace(/\n+$/, "");
  return (
    <div className="md-code">
      <div className="md-code-head">
        <span className="md-code-lang">{lang || "text"}</span>
        <CopyButton text={raw} className="md-code-copy" />
      </div>
      <pre>{children}</pre>
    </div>
  );
}

/** 扩展名 → highlight.js 语言（仅 common 构建已注册者，未知返回 undefined → 不高亮）。 */
function hljsLang(path?: string): string | undefined {
  if (!path) return undefined;
  const ext = (path.split(".").pop() || "").toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
    js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    json: "json", css: "css", scss: "scss", less: "less",
    html: "xml", xml: "xml", svg: "xml", vue: "xml",
    md: "markdown", py: "python", rs: "rust", go: "go", java: "java",
    c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "csharp",
    rb: "ruby", php: "php", sh: "bash", bash: "bash", zsh: "bash",
    yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", sql: "sql",
    swift: "swift", kt: "kotlin", lua: "lua",
  };
  const lang = map[ext];
  return lang && hljs.getLanguage(lang) ? lang : undefined;
}
function highlightLine(code: string, lang: string): { __html: string } {
  try {
    return { __html: hljs.highlight(code, { language: lang, ignoreIllegals: true }).value || " " };
  } catch {
    return { __html: " " };
  }
}

function DiffLines({ unified, path }: { unified: string; path?: string }) {
  const lines = unified.split("\n").filter((l) => !/^(diff --git|index |--- |\+\+\+ )/.test(l));
  const lang = hljsLang(path);
  // 行号双栏（旧 | 新）：优先解析 @@ hunk 头取真实起始行；合成 diff 无 hunk 头则从 1 起。
  let oldNo = 1, newNo = 1;
  return (
    <div className="cv-diff">
      {lines.map((l, i) => {
        if (l.startsWith("@@")) {
          const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
          if (m) {
            oldNo = parseInt(m[1]!, 10);
            newNo = parseInt(m[2]!, 10);
          }
          return (
            <div key={i} className="cv-diff-row hunk">
              <span className="cv-diff-ln" />
              <span className="cv-diff-ln" />
              <span className="cv-diff-sign" />
              <span className="cv-diff-code">{l}</span>
            </div>
          );
        }
        const kind = l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : "ctx";
        const o = kind === "add" ? "" : String(oldNo);
        const n = kind === "del" ? "" : String(newNo);
        if (kind !== "add") oldNo++;
        if (kind !== "del") newNo++;
        const code = l.replace(/^[+-]/, "") || " ";
        return (
          <div key={i} className={`cv-diff-row ${kind}`}>
            <span className="cv-diff-ln">{o}</span>
            <span className="cv-diff-ln">{n}</span>
            <span className="cv-diff-sign">{kind === "add" ? "+" : kind === "del" ? "-" : ""}</span>
            {lang ? (
              <span className="cv-diff-code" dangerouslySetInnerHTML={highlightLine(code, lang)} />
            ) : (
              <span className="cv-diff-code">{code}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** 外链点击：Tauri webview 里直接导航会把整个 app 替换掉且无法返回，
 *  所以统一拦截 → 交给右侧网页预览抽屉（无 handler 时退化为新窗口）。 */
function openExternal(url: string, onOpenUrl?: (url: string) => void) {
  if (onOpenUrl) onOpenUrl(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

/** LCS 行级 diff，统计新增/删除行数（滚动数组 O(m) 空间；大文件退化为行数差，避免卡顿）。 */
function lineDiffStat(before: string[], after: string[]): { adds: number; dels: number } {
  const n = before.length, m = after.length;
  // 精确 LCS 上限（行内工具行/汇总卡每条流式 token 都重算，过大文件退化为行数差，避免卡顿）。
  if (n * m > 250_000) return { adds: Math.max(0, m - n), dels: Math.max(0, n - m) };
  let prev = new Int32Array(m + 1);
  for (let i = n - 1; i >= 0; i--) {
    const curr = new Int32Array(m + 1);
    const bi = before[i];
    for (let j = m - 1; j >= 0; j--) {
      curr[j] = bi === after[j] ? prev[j + 1]! + 1 : Math.max(prev[j]!, curr[j + 1]!);
    }
    prev = curr;
  }
  const lcs = prev[0]!;
  return { adds: m - lcs, dels: n - lcs };
}

function countLines(s?: string | null): number {
  return s ? s.replace(/\n$/, "").split("\n").length : 0;
}

/** 编辑 +/- 行数：优先解析 unified diff；否则用 before/after 计算（新建文件 = 全部新增）。 */
function diffStat(diff?: { before: string | null; after: string; unified: string | null }): {
  adds: number;
  dels: number;
} {
  if (!diff) return { adds: 0, dels: 0 };
  if (diff.unified) {
    let adds = 0, dels = 0;
    for (const line of diff.unified.split("\n")) {
      if (line[0] === "+" && !line.startsWith("+++")) adds++;
      else if (line[0] === "-" && !line.startsWith("---")) dels++;
    }
    if (adds || dels) return { adds, dels };
  }
  const before = diff.before ? diff.before.replace(/\n$/, "").split("\n") : [];
  const after = diff.after ? diff.after.replace(/\n$/, "").split("\n") : [];
  if (before.length === 0) return { adds: after.length, dels: 0 };
  if (after.length === 0) return { adds: 0, dels: before.length };
  return lineDiffStat(before, after);
}

function isEditTool(name: string): boolean {
  return /^(fs_)?(write|edit|apply_patch|str_replace_editor|create_file)$/i.test(name);
}

/** 从 old/new 文本合成 unified（旧行 − / 新行 +）；write 类只有新内容时整块呈现为新增。 */
function synthUnified(oldStr: string, newStr: string): string {
  const o = oldStr ? oldStr.replace(/\n$/, "").split("\n") : [];
  const n = newStr ? newStr.replace(/\n$/, "").split("\n") : [];
  return [...o.map((l) => "-" + l), ...n.map((l) => "+" + l)].join("\n");
}

/** 编辑工具展开体：优先真实 diff 载荷；缺失则从 args 合成内容 diff（patch / old+new / 仅 content）。 */
function editPreview(t: UiTool): ReactNode {
  const path = t.diff?.path || toolSubject(t.args);
  if (t.diff?.unified) return <DiffLines unified={t.diff.unified} path={path} />;
  if (t.diff && (t.diff.before != null || t.diff.after)) {
    return <DiffLines unified={synthUnified(t.diff.before ?? "", t.diff.after ?? "")} path={path} />;
  }
  try {
    const a = JSON.parse(t.args || "{}") as Record<string, unknown>;
    const pick = (...keys: string[]) => {
      for (const k of keys) if (typeof a[k] === "string") return a[k] as string;
      return null;
    };
    const patch = pick("patch", "diff", "unified", "input");
    if (patch) return <DiffLines unified={patch} path={path} />;
    const oldStr = pick("old_str", "old_string", "oldText", "old");
    const newStr = pick("new_str", "new_string", "newText", "new", "content", "text", "contents");
    if (oldStr != null || newStr != null) {
      return <DiffLines unified={synthUnified(oldStr ?? "", newStr ?? "")} path={path} />;
    }
  } catch {
    /* args 非 JSON：落到参数兜底 */
  }
  return (
    <div className="cv-kv">
      <span>参数</span>
      <code>{t.args || "{}"}</code>
    </div>
  );
}
function isRunTool(name: string): boolean {
  return /^(run_command|bash|shell|exec)$/i.test(name);
}
function isReadTool(name: string): boolean {
  return /^(fs_)?(read|view|cat|open_file|read_file)$/i.test(name);
}
function isCodeSearchTool(name: string): boolean {
  return /^(fs_)?(grep|rg|ripgrep|search|search_files|search_code|glob|find)$/i.test(name);
}
function isListTool(name: string): boolean {
  return /^(fs_)?(ls|list|list_dir|list_files)$/i.test(name);
}
/** 「探索」类工具：本地只读勘探（读 / 搜 / 列 / 找），可聚合成一组；不含 web_search / 编辑 / 运行。 */
function isExploreTool(name: string): boolean {
  return isReadTool(name) || isCodeSearchTool(name) || isListTool(name);
}

/** 探索组里一步的过去式标签 + 内容节点（读=徽章+文件名+路径；搜/找=查询；列=路径）。 */
function exploreStep(t: UiTool): { label: string; node: ReactNode } {
  if (isReadTool(t.name)) {
    const full = t.diff?.path || toolSubject(t.args) || "";
    const name = full.split(/[/\\]/).pop() || full;
    const dir = full.slice(0, full.length - name.length);
    const ft = fileType(full);
    return {
      label: "已读取",
      node: (
        <>
          <span className="cv-fbadge sm" style={{ background: ft.color }}>{ft.label}</span>
          <span className="cv-fname">{name || "(文件)"}</span>
          {dir && <span className="cv-fpath">{dir}</span>}
        </>
      ),
    };
  }
  if (isListTool(t.name)) {
    return { label: "已列出", node: <span className="cv-q">{toolSubject(t.args) || "."}</span> };
  }
  // 搜索 / 查找
  const q = toolQuery(t.args) || toolSubject(t.args);
  const find = /find|glob/i.test(t.name);
  return { label: find ? "已查找" : "已搜索", node: <span className="cv-q">{q || "(无)"}</span> };
}

/** 渲染项：把连续的探索类工具块聚合成一个 explore 组，其余块原样透传（保留原始下标供光标定位）。 */
type RenderItem =
  | { kind: "explore"; tools: UiTool[]; lastBi: number }
  | { kind: "block"; block: UiBlock; bi: number };
function groupExplore(blocks: UiBlock[]): RenderItem[] {
  const out: RenderItem[] = [];
  let run: { tools: UiTool[]; lastBi: number } | null = null;
  const flush = () => {
    if (run) out.push({ kind: "explore", tools: run.tools, lastBi: run.lastBi });
    run = null;
  };
  blocks.forEach((block, bi) => {
    if (block.kind === "tool" && isExploreTool(block.tool.name)) {
      if (!run) run = { tools: [], lastBi: bi };
      run.tools.push(block.tool);
      run.lastBi = bi;
    } else {
      flush();
      out.push({ kind: "block", block, bi });
    }
  });
  flush();
  return out;
}

/** 探索组（聚合的连续只读勘探）：扁平左竖线 + 过去式步骤，默认折叠、运行中展开。 */
function ExploreGroup({ tools }: { tools: UiTool[] }) {
  const running = tools.some((t) => t.status === "running");
  const err = tools.some((t) => t.status === "error");
  const files = tools.filter((t) => isReadTool(t.name)).length;
  const probes = tools.length - files;
  const summary =
    [probes ? `${probes} 搜索` : null, files ? `${files} 文件` : null].filter(Boolean).join(", ") ||
    `${tools.length} 步`;
  return (
    <div className="cv-xwrap">
      <details className={`cv-x${err ? " error" : ""}`} open={running}>
        <summary className="cv-xhead">
          <SearchIcon size={14} className="cv-xico" />
          <span className="cv-xverb">探索</span>
          <span className="cv-xsum">· {running ? "勘探中…" : summary}</span>
          <ChevronIcon size={12} className="cv-xchev" />
        </summary>
        <div className="cv-xbody">
          {tools.map((t, j) => {
            const { label, node } = exploreStep(t);
            return (
              <div key={t.id || j} className="cv-step">
                <span className="cv-slabel">{label}</span>
                <span className="cv-scontent">{node}</span>
              </div>
            );
          })}
        </div>
      </details>
    </div>
  );
}

export interface FileChange {
  path: string;
  adds: number;
  dels: number;
}

/** 汇总一条助手消息里的所有文件改动（按路径合并，多次编辑累加）。 */
export function aggregateEdits(blocks: { kind: string; tool?: UiTool }[]): FileChange[] {
  const map = new Map<string, { adds: number; dels: number }>();
  for (const b of blocks) {
    if (b.kind !== "tool" || !b.tool || !isEditTool(b.tool.name)) continue;
    const path = b.tool.diff?.path || toolSubject(b.tool.args);
    if (!path) continue;
    const { adds, dels } = editStat(b.tool);
    const prev = map.get(path) ?? { adds: 0, dels: 0 };
    map.set(path, { adds: prev.adds + adds, dels: prev.dels + dels });
  }
  // 过滤掉无可计量改动的条目（如无 diff 载荷且参数键未识别的工具）——避免汇总卡出现 +0 −0 幽灵行。
  return [...map.entries()].map(([path, s]) => ({ path, ...s })).filter((e) => e.adds || e.dels);
}

/** 编辑工具的 +/-：优先 diff 载荷；缺失时从 args 兜底（write 的 content / str_replace 的 old/new）。 */
function editStat(t: UiTool): { adds: number; dels: number } {
  if (t.diff) {
    const s = diffStat(t.diff);
    if (s.adds || s.dels) return s;
  }
  try {
    const a = JSON.parse(t.args || "{}") as Record<string, unknown>;
    const pick = (...keys: string[]) => {
      for (const k of keys) if (typeof a[k] === "string") return a[k] as string;
      return null;
    };
    const oldStr = pick("old_str", "old_string", "oldText", "old");
    const newStr = pick("new_str", "new_string", "newText", "new", "content", "text", "contents");
    // str_replace（old+new 都有）：按行 diff 计 +/-，避免「改 1 行报 +N −N」式虚高；
    // write（仅 new/content）：整块新增。
    if (oldStr != null && newStr != null) {
      const before = oldStr ? oldStr.replace(/\n$/, "").split("\n") : [];
      const after = newStr ? newStr.replace(/\n$/, "").split("\n") : [];
      if (before.length === 0) return { adds: after.length, dels: 0 };
      if (after.length === 0) return { adds: 0, dels: before.length };
      return lineDiffStat(before, after);
    }
    if (oldStr != null || newStr != null) return { adds: countLines(newStr), dels: countLines(oldStr) };
  } catch {
    /* args 非 JSON：忽略 */
  }
  return { adds: 0, dels: 0 };
}

/** 行内工具调用（设计：单行 动词 + 载荷 + 统计/状态，点击展开详情）。 */
export function ToolView({ t, onOpenUrl }: { t: UiTool; onOpenUrl?: (url: string) => void }) {
  const statusChip = (label: string) =>
    t.status === "error" ? (
      <span className="cv-tchip err">失败</span>
    ) : t.status === "done" ? (
      <span className="cv-tchip">{label}</span>
    ) : (
      <span className="cv-tline-meta">运行中…</span>
    );

  if (t.name === "web_search") {
    const q = toolQuery(t.args);
    const hasSrc = !!(t.sources && t.sources.length);
    return (
      <div className="cv-tool-wrap">
        <details className={`cv-tool ${t.status}`} open={t.status === "running" || hasSrc}>
          <summary className="cv-tline">
            <GlobeIcon size={14} className="cv-tline-ico" />
            <span className="cv-tline-verb">搜索</span>
            {q && <span className="cv-tname">{q}</span>}
            {statusChip("完成")}
            <ChevronIcon size={12} className="cv-tline-chev" />
          </summary>
          <div className="cv-tool-body">
            {hasSrc ? (
              <div className="cv-search-chips">
                {t.sources!.map((s, j) => (
                  <button
                    key={j}
                    type="button"
                    className="src-chip"
                    title={s.url}
                    onClick={() => openExternal(s.url, onOpenUrl)}
                  >
                    <img
                      src={`https://www.google.com/s2/favicons?domain=${host(s.url)}&sz=64`}
                      alt=""
                      onError={(e) => (e.currentTarget.style.visibility = "hidden")}
                    />
                    <span>{s.title || host(s.url)}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="cv-kv">
                <span>查询</span>
                <code>{q || "（无）"}</code>
              </div>
            )}
          </div>
        </details>
      </div>
    );
  }

  const run = isRunTool(t.name);
  const edit = isEditTool(t.name);
  const read = /^(fs_)?(read|view|cat|open_file)$/i.test(t.name);
  const subject = toolSubject(t.args) || t.diff?.path || "";
  const Icon = run ? SquareTerminalIcon : edit ? EditIcon : read ? FileIcon : WrenchIcon;
  const verb = run
    ? t.status === "running"
      ? "执行中"
      : t.status === "error"
        ? "执行失败"
        : "已执行"
    : edit
      ? t.status === "running"
        ? "编辑中"
        : "已编辑"
      : read
        ? "已读取"
        : t.name;
  const filePath = t.diff?.path || subject;
  const fileName = filePath.split(/[/\\]/).pop() || filePath;
  const fileDir = filePath.slice(0, filePath.length - fileName.length);
  const { adds, dels } = edit ? editStat(t) : { adds: 0, dels: 0 };
  const fb = edit ? fileType(filePath) : null;

  return (
    <div className="cv-tool-wrap">
      <details className={`cv-tool ${t.status}`} open={t.status === "running" && run}>
        <summary className="cv-tline">
          <Icon size={14} className="cv-tline-ico" />
          <span className="cv-tline-verb">{verb}</span>
          {edit && fb ? (
            <span className="cv-tfile" title={filePath}>
              <span className="cv-fbadge" style={{ background: fb.color }}>
                {fb.label}
              </span>
              <span className="cv-fname">{fileName}</span>
              {fileDir && <span className="cv-fpath">{fileDir}</span>}
            </span>
          ) : run ? (
            // 折叠态显示命令预览（单行省略）；展开后由正文 $ 提示行接管，故展开时隐藏（见 css）
            <code className="cv-tcmd" title={subject}>{subject || "命令"}</code>
          ) : (
            subject && <span className="cv-tname">{subject}</span>
          )}
          {edit && (adds > 0 || dels > 0) && (
            <span className="cv-tstat">
              <span className="add">+{adds}</span> <span className="del">−{dels}</span>
            </span>
          )}
          {!run && (t.status === "error" || (!edit && !read)) && statusChip("完成")}
          <ChevronIcon size={12} className="cv-tline-chev" />
        </summary>
        <div className="cv-tool-body">
          {run ? (
            <div className="cv-term">
              <div className="cv-term-cmd">
                <span className="cv-term-dollar">$ </span>
                {subject || "命令"}
              </div>
              {(t.output || t.result) && <pre className="cv-term-out">{t.output || t.result}</pre>}
            </div>
          ) : edit ? (
            editPreview(t)
          ) : (
            <>
              <div className="cv-kv">
                <span>参数</span>
                <code>{t.args || "{}"}</code>
              </div>
              {t.result != null && (
                <div className="cv-kv">
                  <span>结果</span>
                  <code>{t.result}</code>
                </div>
              )}
            </>
          )}
        </div>
      </details>
      {t.citations && t.citations.length > 0 && (
        <div className="citations">
          <div className="cite-head">引用来源</div>
          <div className="cite-list">
            {t.citations.map((c) => (
              <span key={c.id} className="cite-chip" title={c.source}>
                <b>[{c.id}]</b> {c.source}
              </span>
            ))}
          </div>
        </div>
      )}
      {t.html && (
        <div className="artifact">
          <div className="artifact-head">
            <CodeIcon size={13} /> {t.htmlTitle || "HTML 工件"}
          </div>
          <iframe className="artifact-frame" sandbox="allow-scripts" title={t.htmlTitle || "artifact"} srcDoc={t.html} />
        </div>
      )}
    </div>
  );
}

/** Agent Desk 消息流（头像 + 名 + 时间线：思考/工具/文本）。聊天与工作区共用。 */
export function MessageStream({
  msgs,
  busy,
  onOpenUrl,
  onOpenFile,
  onRetry,
  onEdit,
}: {
  msgs: UiMsg[];
  busy: boolean;
  onOpenUrl?: (url: string) => void;
  /** 点击「文件改动」卡里的某文件 → 跳转查看其 diff（打开工作台）。 */
  onOpenFile?: (path: string) => void;
  /** 重试上一次输入（重发最后一条用户消息）。仅最后一条用户消息显示。 */
  onRetry?: () => void;
  /** 编辑最后一条用户消息后重发（改文本 → 重新生成）。 */
  onEdit?: (text: string) => void;
}) {
  const mdLink = ({ href, children }: { href?: string; children?: ReactNode }) => (
    <a
      href={href}
      onClick={(e) => {
        if (!href || !/^https?:/i.test(href)) return;
        e.preventDefault();
        openExternal(href, onOpenUrl);
      }}
    >
      {children}
    </a>
  );
  // 最后一条用户消息的下标——「编辑 / 重试」只挂它（重新生成上一轮）。
  const lastUserIdx = msgs.reduce((acc, m, idx) => (m.role === "user" ? idx : acc), -1);
  // 内联编辑状态：正在编辑的消息下标 + 草稿文本。
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [editText, setEditText] = useState("");
  const submitEdit = () => {
    if (!editText.trim()) return;
    onEdit?.(editText);
    setEditIdx(null);
  };
  return (
    <>
      {msgs.map((m, i) => {
        if (m.role === "user")
          return (
            <div key={i} className="cv-msg user">
              <div className="cv-col">
                <div className="cv-head">
                  <span className="cv-name">You</span>
                  {m.at && <span className="cv-time">{fmtTime(m.at)}</span>}
                </div>
                {m.images && m.images.length > 0 && (
                  <div className="cv-images">
                    {m.images.map((im, j) => (
                      <img key={j} src={`data:${im.mimeType};base64,${im.data}`} alt="" />
                    ))}
                  </div>
                )}
                {i === lastUserIdx && editIdx === i ? (
                  <div className="cv-edit">
                    <textarea
                      className="cv-edit-area"
                      value={editText}
                      autoFocus
                      rows={Math.min(8, editText.split("\n").length)}
                      onChange={(e) => setEditText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          submitEdit();
                        } else if (e.key === "Escape") {
                          setEditIdx(null);
                        }
                      }}
                    />
                    <div className="cv-edit-actions">
                      <button className="cv-edit-cancel" onClick={() => setEditIdx(null)}>
                        取消
                      </button>
                      <button className="cv-edit-send" onClick={submitEdit} disabled={!editText.trim()}>
                        发送
                      </button>
                    </div>
                  </div>
                ) : (
                  m.raw && <div className="cv-userbubble">{m.raw}</div>
                )}
                {i === lastUserIdx && !busy && editIdx !== i && (onEdit || onRetry) && (
                  <div className="cv-actions user">
                    {onEdit && (
                      <button
                        className="cv-action"
                        title="编辑后重新生成"
                        onClick={() => {
                          setEditText(m.raw);
                          setEditIdx(i);
                        }}
                      >
                        <EditIcon size={14} /> <span>编辑</span>
                      </button>
                    )}
                    {onRetry && (
                      <button className="cv-action" title="重新生成回答" onClick={onRetry}>
                        <RefreshIcon size={14} /> <span>重试</span>
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        const answer = splitThink(m.raw).answer;
        const isLast = i === msgs.length - 1;
        const live = busy && isLast;
        const blocks = m.blocks ?? [];
        const lastIdx = blocks.length - 1;
        return (
          <div key={i} className="cv-msg assistant">
            <span className="cv-avatar bot">
              <SparkIcon size={15} />
            </span>
            <div className="cv-col">
              <div className="cv-head">
                <span className="cv-name">AI assistant</span>
              </div>
              {(() => {
                const items = groupExplore(blocks);
                // 一条「过程」项 = 探索组 / 思考 / 非文本工具（编辑·运行·web_search）；末尾的文本块是最终答复。
                let lastProc = -1;
                items.forEach((it, idx) => {
                  if (it.kind === "explore" || (it.kind === "block" && it.block.kind !== "text")) lastProc = idx;
                });
                const renderItem = (it: RenderItem): ReactNode => {
                  if (it.kind === "explore") return <ExploreGroup key={`x${it.lastBi}`} tools={it.tools} />;
                  const b = it.block;
                  const bi = it.bi;
                  if (b.kind === "reasoning") {
                    const liveThis = live && bi === lastIdx;
                    const dur = b.end ? (b.end - b.start) / 1000 : null;
                    const statusLabel = liveThis
                      ? "思考中…"
                      : dur != null
                        ? `${dur < 1 ? "<1" : Math.round(dur)} 秒`
                        : "完成";
                    return (
                      <div key={bi} className="cv-xwrap think">
                        <details className="cv-x think" open={liveThis}>
                          <summary className="cv-xhead">
                            <BrainIcon size={14} className="cv-xico" />
                            <span className="cv-xverb">思考</span>
                            <span className="cv-xsum">· {statusLabel}</span>
                            <ChevronIcon size={12} className="cv-xchev" />
                          </summary>
                          <div className="cv-xbody reason">{b.text}</div>
                        </details>
                      </div>
                    );
                  }
                  if (b.kind === "tool") return <ToolView key={bi} t={b.tool} onOpenUrl={onOpenUrl} />;
                  return (
                    <div key={bi} className="text md">
                      <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={{ a: mdLink, pre: CodeBlock }}>
                        {b.text}
                      </Markdown>
                      {live && bi === lastIdx && <span className="cursor" />}
                    </div>
                  );
                };
                // 无过程（纯文本答复）→ 不套工作日志，直接渲染。
                if (lastProc < 0) return <>{items.map(renderItem)}</>;
                const workMs = m.start != null ? (m.end ?? (live ? Date.now() : m.start)) - m.start : 0;
                return (
                  <>
                    <details className="cv-worklog" open={live}>
                      <summary className="cv-worklog-h">
                        <ClockIcon size={13} className="cv-worklog-ico" />
                        <span className="cv-worklog-label">{live ? "工作中…" : fmtWork(workMs)}</span>
                        <ChevronIcon size={12} className="cv-worklog-chev" />
                      </summary>
                      <div className="cv-worklog-body">{items.slice(0, lastProc + 1).map(renderItem)}</div>
                    </details>
                    {items.slice(lastProc + 1).map(renderItem)}
                  </>
                );
              })()}
              {(() => {
                const edits = aggregateEdits(blocks);
                if (edits.length === 0) return null;
                const totAdds = edits.reduce((n, e) => n + e.adds, 0);
                const totDels = edits.reduce((n, e) => n + e.dels, 0);
                return (
                  <details className="cv-changes">
                    <summary className="cv-changes-h">
                      <span className="cv-changes-title">{edits.length} 个文件改动</span>
                      <span className="cv-changes-tot mono">
                        <span className="add">+{totAdds}</span> <span className="del">−{totDels}</span>
                      </span>
                      <ChevronIcon size={13} className="cv-changes-chev" />
                    </summary>
                    {edits.map((e) => {
                      const ft = fileType(e.path);
                      const name = e.path.split(/[/\\]/).pop() || e.path;
                      return (
                        <button
                          key={e.path}
                          className="cv-changes-row"
                          title={`${e.path} — 查看改动`}
                          onClick={() => onOpenFile?.(e.path)}
                        >
                          <span className="cv-changes-badge" style={{ background: ft.color }}>
                            {ft.label}
                          </span>
                          <span className="cv-changes-name">{name}</span>
                          <span className="cv-changes-stat mono">
                            <span className="add">+{e.adds}</span> <span className="del">−{e.dels}</span>
                          </span>
                        </button>
                      );
                    })}
                  </details>
                );
              })()}
              {answer && !live && (
                <div className="cv-actions">
                  <CopyButton text={answer} className="cv-action" label="复制" />
                  {(m.end ?? m.start) != null && <span className="cv-msg-time">{fmtTime((m.end ?? m.start)!)}</span>}
                </div>
              )}
              {blocks.length === 0 && live && (
                <div className="cv-think">
                  <span />
                  <span />
                  <span />
                </div>
              )}
              {m.cancelled && <div className="cancel-note">已停止 · 本轮不计入上下文</div>}
            </div>
          </div>
        );
      })}
    </>
  );
}
