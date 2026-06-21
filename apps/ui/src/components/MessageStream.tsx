import { useState } from "react";
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

/** Agent Desk 工具卡：READ / EDIT(diff) / RUN(终端) / 通用 + web_search 来源 + 引用 / HTML 工件。 */
export function ToolView({ t }: { t: UiTool }) {
  if (t.name === "web_search") {
    return (
      <div className="cv-search">
        <div className="cv-search-head">
          <GlobeIcon size={14} />
          <span>
            {t.status === "running" ? "正在搜索" : "已搜索"}
            {toolQuery(t.args) && ` “${toolQuery(t.args)}”`}
          </span>
        </div>
        {t.sources && t.sources.length > 0 && (
          <div className="cv-search-chips">
            {t.sources.map((s, j) => (
              <a key={j} className="src-chip" href={s.url} target="_blank" rel="noreferrer" title={s.url}>
                <img
                  src={`https://www.google.com/s2/favicons?domain=${host(s.url)}&sz=64`}
                  alt=""
                  onError={(e) => (e.currentTarget.style.visibility = "hidden")}
                />
                <span>{s.title || host(s.url)}</span>
              </a>
            ))}
          </div>
        )}
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
export function MessageStream({ msgs, busy }: { msgs: UiMsg[]; busy: boolean }) {
  return (
    <>
      {msgs.map((m, i) => {
        if (m.role === "user")
          return (
            <div key={i} className="cv-msg user">
              <span className="cv-avatar user">你</span>
              <div className="cv-col">
                <div className="cv-head">
                  <span className="cv-name">你</span>
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
                <span className="cv-name">助手</span>
              </div>
              {blocks.map((b, bi) => {
                if (b.kind === "reasoning") {
                  const liveThis = live && bi === lastIdx;
                  const dur = b.end ? (b.end - b.start) / 1000 : null;
                  const label = liveThis
                    ? "思考中…"
                    : dur != null
                      ? `思考了 ${dur < 1 ? "<1" : Math.round(dur)} 秒`
                      : "思考过程";
                  return (
                    <details key={bi} className="reason" open={liveThis}>
                      <summary>
                        <BrainIcon size={15} />
                        <span>{label}</span>
                        <ChevronIcon size={14} className="chev" />
                      </summary>
                      <div className="reason-body">{b.text}</div>
                    </details>
                  );
                }
                if (b.kind === "tool") return <ToolView key={bi} t={b.tool} />;
                return (
                  <div key={bi} className="text md">
                    <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
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
