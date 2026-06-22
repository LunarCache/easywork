import { useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { splitThink, type UiMsg, type UiTool } from "../lib/agent-stream.js";
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

/** Agent Desk 工具卡：READ / EDIT(diff) / RUN(终端) / 通用 + web_search 来源 + 引用 / HTML 工件。 */
export function ToolView({ t, onOpenUrl }: { t: UiTool; onOpenUrl?: (url: string) => void }) {
  if (t.name === "web_search") {
    const q = toolQuery(t.args);
    const hasSrc = !!(t.sources && t.sources.length);
    const statusLabel = t.status === "running" ? "搜索中…" : t.status === "error" ? "失败" : "完成";
    return (
      <div className="cv-tool-wrap">
        <details className={`cv-tool ${t.status}`} open={t.status === "running" || hasSrc}>
          <summary>
            <GlobeIcon size={14} className="cv-tool-ico" />
            <span className="cv-tool-label">SEARCH</span>
            {q && <span className="cv-tool-name">{q}</span>}
            <span className={`cv-tool-status ${t.status}`}>
              <span className="cv-tool-dot" /> {statusLabel}
            </span>
            <ChevronIcon size={13} className="chev" />
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

  const run = t.name === "run_command";
  const edit = t.name === "fs_write" || t.name === "fs_edit";
  const read = t.name === "fs_read";
  const kind = run ? "RUN" : edit ? "EDIT" : read ? "READ" : t.name.toUpperCase();
  const Icon = run ? TerminalIcon : edit ? EditIcon : read ? FileIcon : WrenchIcon;
  const subject = toolSubject(t.args) || t.diff?.path || "";
  const statusLabel = t.status === "running" ? "运行中…" : t.status === "error" ? "失败" : "完成";

  return (
    <div className="cv-tool-wrap">
      <details className={`cv-tool ${t.status}`} open={t.status === "running" && run}>
        <summary>
          <Icon size={14} className="cv-tool-ico" />
          <span className="cv-tool-label">{kind}</span>
          {subject && <span className="cv-tool-name">{subject}</span>}
          <span className={`cv-tool-status ${t.status}`}>
            <span className="cv-tool-dot" /> {statusLabel}
          </span>
          <ChevronIcon size={13} className="chev" />
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
}: {
  msgs: UiMsg[];
  busy: boolean;
  onOpenUrl?: (url: string) => void;
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
                      <details className={`cv-tool ${status}`} open={liveThis}>
                        <summary>
                          <BrainIcon size={14} className="cv-tool-ico" />
                          <span className="cv-tool-label">THINK</span>
                          <span className={`cv-tool-status ${status}`}>
                            <span className="cv-tool-dot" /> {statusLabel}
                          </span>
                          <ChevronIcon size={13} className="chev" />
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
