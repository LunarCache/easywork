import { useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { splitThink, type UiMsg, type UiTool } from "../lib/agent-stream.js";
import { fileType } from "../lib/filetype.js";
import {
  BrainIcon,
  ChevronIcon,
  GlobeIcon,
  WrenchIcon,
  TerminalIcon,
  EditIcon,
  FileIcon,
  CodeIcon,
  SparkIcon,
  CopyIcon,
  CheckIcon,
} from "../icons.js";

function fmtTime(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
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

export function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="msg-action"
      title="复制"
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    >
      {done ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
    </button>
  );
}

function DiffLines({ unified }: { unified: string }) {
  const lines = unified.split("\n").filter((l) => !/^(diff --git|index |--- |\+\+\+ )/.test(l));
  return (
    <div className="cv-diff">
      {lines.map((l, i) => {
        const kind = l.startsWith("@@") ? "hunk" : l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : "ctx";
        return (
          <div key={i} className={`cv-diff-row ${kind}`}>
            <span className="cv-diff-sign">{kind === "add" ? "+" : kind === "del" ? "-" : ""}</span>
            <span className="cv-diff-code">{kind === "hunk" ? l : l.replace(/^[+-]/, "") || " "}</span>
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
  return [...map.entries()].map(([path, s]) => ({ path, ...s }));
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

  const run = /^(run_command|bash|shell|exec)$/i.test(t.name);
  const edit = isEditTool(t.name);
  const read = /^(fs_)?(read|view|cat|open_file)$/i.test(t.name);
  const subject = toolSubject(t.args) || t.diff?.path || "";
  const Icon = run ? TerminalIcon : edit ? EditIcon : read ? FileIcon : WrenchIcon;
  const verb = run ? "运行" : edit ? "编辑" : read ? "读取" : t.name;
  const filePath = t.diff?.path || subject;
  const { adds, dels } = edit ? editStat(t) : { adds: 0, dels: 0 };
  const fb = edit ? fileType(filePath) : null;

  return (
    <div className="cv-tool-wrap">
      <details className={`cv-tool ${t.status}`} open={t.status === "running" && run}>
        <summary className="cv-tline">
          <Icon size={14} className="cv-tline-ico" />
          <span className="cv-tline-verb">{verb}</span>
          {edit && fb ? (
            <span className="cv-tfile">
              <span className="cv-fbadge" style={{ background: fb.color }}>
                {fb.label}
              </span>
              <span className="cv-tname">{filePath}</span>
            </span>
          ) : run ? (
            <code className="cv-tcmd">{subject || "命令"}</code>
          ) : (
            subject && <span className="cv-tname">{subject}</span>
          )}
          {edit && (adds > 0 || dels > 0) && (
            <span className="cv-tstat">
              <span className="add">+{adds}</span> <span className="del">−{dels}</span>
            </span>
          )}
          {(t.status === "error" || run || (!edit && !read)) && statusChip("完成")}
          <ChevronIcon size={12} className="cv-tline-chev" />
        </summary>
        <div className="cv-tool-body">
          {run ? (
            <pre className="cv-term">{t.output || t.result || "（无输出）"}</pre>
          ) : edit && t.diff?.unified ? (
            <DiffLines unified={t.diff.unified} />
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
}: {
  msgs: UiMsg[];
  busy: boolean;
  onOpenUrl?: (url: string) => void;
  /** 点击「文件改动」卡里的某文件 → 跳转查看其 diff（打开工作台）。 */
  onOpenFile?: (path: string) => void;
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
                {m.raw && <div className="cv-userbubble">{m.raw}</div>}
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
              {blocks.map((b, bi) => {
                if (b.kind === "reasoning") {
                  const liveThis = live && bi === lastIdx;
                  const dur = b.end ? (b.end - b.start) / 1000 : null;
                  const status = liveThis ? "running" : "done";
                  const statusLabel = liveThis
                    ? "思考中…"
                    : dur != null
                      ? `${dur < 1 ? "<1" : Math.round(dur)} 秒`
                      : "完成";
                  return (
                    <div key={bi} className="cv-tool-wrap">
                      <details className={`cv-tool think ${status}`} open={liveThis}>
                        <summary className="cv-tline">
                          <BrainIcon size={14} className="cv-tline-ico" />
                          <span className="cv-tline-verb">思考</span>
                          <span className="cv-tline-meta">{statusLabel}</span>
                          <ChevronIcon size={12} className="cv-tline-chev" />
                        </summary>
                        <div className="cv-tool-body">
                          <div className="cv-reason">{b.text}</div>
                        </div>
                      </details>
                    </div>
                  );
                }
                if (b.kind === "tool") return <ToolView key={bi} t={b.tool} onOpenUrl={onOpenUrl} />;
                return (
                  <div key={bi} className="text md">
                    <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={{ a: mdLink }}>
                      {b.text}
                    </Markdown>
                    {live && bi === lastIdx && <span className="cursor" />}
                  </div>
                );
              })}
              {(() => {
                const edits = aggregateEdits(blocks);
                if (edits.length === 0) return null;
                const totAdds = edits.reduce((n, e) => n + e.adds, 0);
                const totDels = edits.reduce((n, e) => n + e.dels, 0);
                return (
                  <div className="cv-changes">
                    <div className="cv-changes-h">
                      <span className="cv-changes-title">{edits.length} 个文件改动</span>
                      <span className="cv-changes-tot mono">
                        <span className="add">+{totAdds}</span> <span className="del">−{totDels}</span>
                      </span>
                    </div>
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
                  </div>
                );
              })()}
              {answer && !live && <CopyButton text={answer} />}
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
