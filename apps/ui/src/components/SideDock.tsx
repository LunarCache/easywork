import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { ExecResult, GitCommit, GitFile, GitRemoteInfo, GitStatus, WsEntry } from "@ew/sdk";
import { getClient } from "../lib/client.js";
import { CopyButton } from "./MessageStream.js";
import { fileType } from "../lib/filetype.js";
import type { UiMsg } from "../lib/agent-stream.js";
import {
  ArrowLeftIcon,
  ChevronIcon,
  CommitIcon,
  CopyIcon,
  CheckIcon,
  DownloadIcon,
  EnterIcon,
  FileIcon,
  FolderIcon,
  GlobeIcon,
  MaximizeIcon,
  MinimizeIcon,
  RefreshIcon,
  TerminalIcon,
  UndoIcon,
  UploadIcon,
  XIcon,
} from "../icons.js";

// ===== 共享类型 =====
export interface FilePreview {
  content?: string;
  binary?: boolean;
  truncated?: boolean;
  size: number;
}
/** git 上下文：提供则出现「改动」tab（工作区模式）。 */
export interface GitContext {
  projectId: string;
  status: GitStatus;
  remote: GitRemoteInfo;
  onRefresh: () => Promise<void>;
}

type Tab = "diff" | "files" | "terminal" | "preview";

function fileIconFor(p: string) {
  const ft = fileType(p);
  return <ft.Icon size={14} style={{ color: ft.color }} />;
}
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 统一右侧「工作台坞」：对话区与工作区共用。
 * tab = 改动(git，按需) / 文件(工件+文件树) / 终端(最近命令) / 预览(网页)。
 * 合并了原 ArtifactsPanel、独立 WebPreview、WorkspacePanel 三套抽屉。
 */
interface TermEntry {
  cmd: string;
  output: string;
  code: number | null;
  truncated?: boolean;
}

export function SideDock({
  open,
  onClose,
  files,
  readFile,
  onFilesRefresh,
  onRevealDir,
  filesEmpty,
  msgs,
  exec,
  previewUrl,
  onClearPreview,
  git,
  target,
}: {
  open: boolean;
  onClose: () => void;
  files: WsEntry[];
  readFile: (path: string) => Promise<FilePreview>;
  onFilesRefresh: () => void;
  onRevealDir: () => void;
  filesEmpty: ReactNode;
  msgs: UiMsg[];
  exec: (command: string) => Promise<ExecResult>;
  previewUrl: string | null;
  onClearPreview: () => void;
  git?: GitContext;
  /** 外部请求查看某文件的改动（点「文件改动」卡）：跳到 改动(工作区)/文件(对话) 视图。 */
  target?: { path: string; nonce: number } | null;
}) {
  // view = null 时显示启动菜单（文件/浏览器/终端/改动 大行）；选中后显示对应内容。
  const [view, setView] = useState<Tab | null>(null);
  const [maxed, setMaxed] = useState(false);
  const [termHistory, setTermHistory] = useState<TermEntry[]>([]);
  const repo = !!git?.status.repo;
  // repo 经 ref 读取：仅 target.nonce 变化（点击改动卡）才切视图；
  // git 状态后台刷新（repo false→true）不应把用户从当前视图（终端/预览）拽回 diff。
  const repoRef = useRef(repo);
  repoRef.current = repo;

  // 「文件改动」卡点击 → git 仓库跳到 diff；否则跳到「文件」视图（FilesTab 按 nonce 定位文件）。
  useEffect(() => {
    if (!target) return;
    setView(repoRef.current ? "diff" : "files");
  }, [target?.nonce]);

  // 点消息里的链接/来源 → 自动进「浏览器」（开关由父组件负责）。
  useEffect(() => {
    if (previewUrl) setView("preview");
  }, [previewUrl]);

  const runCommand = async (c: string) => {
    setTermHistory((h) => [...h, { cmd: c, output: "运行中…", code: null }]);
    const r = await exec(c).catch((e: unknown) => ({
      code: -1,
      output: `[请求失败] ${e instanceof Error ? e.message : String(e)}`,
      truncated: false,
    }));
    setTermHistory((h) => {
      const n = h.slice();
      n[n.length - 1] = { cmd: c, output: r.output || "（无输出）", code: r.code, truncated: r.truncated };
      return n;
    });
  };

  const gitAdds = git ? git.status.files.reduce((s, f) => s + f.adds, 0) : 0;
  const gitDels = git ? git.status.files.reduce((s, f) => s + f.dels, 0) : 0;
  const VIEW_LABEL: Record<Tab, string> = { diff: "改动", files: "文件", terminal: "终端", preview: "浏览器" };

  return (
    <aside className={`side-dock ${open ? "open" : ""} ${maxed ? "max" : ""}`}>
      <div className="sd-top">
        {view !== null && (
          <button className="fv-btn" title="返回" onClick={() => setView(null)}>
            <ArrowLeftIcon size={15} />
          </button>
        )}
        <span className="sd-top-title">{view !== null ? VIEW_LABEL[view] : "工作台"}</span>
        <span className="bar-spacer" />
        {view === "files" && (
          <>
            <button className="fv-btn" title="在文件管理器中打开目录" onClick={onRevealDir}>
              <FolderIcon size={14} />
            </button>
            <button className="fv-btn" title="刷新" onClick={onFilesRefresh}>
              <RefreshIcon size={13} />
            </button>
          </>
        )}
        {view === "diff" && git && (
          <button className="fv-btn" title="刷新" onClick={() => void git.onRefresh()}>
            <RefreshIcon size={13} />
          </button>
        )}
        <button className="fv-btn" title={maxed ? "还原" : "放大到窗口"} onClick={() => setMaxed((v) => !v)}>
          {maxed ? <MinimizeIcon size={13} /> : <MaximizeIcon size={13} />}
        </button>
        <button className="fv-btn" title="关闭" onClick={onClose}>
          <XIcon size={14} />
        </button>
      </div>

      <div className="sd-body">
        {view === null && (
          <div className="sd-launch">
            {git && git.status.repo && (
              <button className="sd-launch-row" onClick={() => setView("diff")}>
                <FileIcon size={18} className="sd-launch-ico" />
                <span className="sd-launch-label">改动</span>
                <span className="sd-launch-stat mono">
                  <span className="add">+{gitAdds}</span> <span className="del">−{gitDels}</span>
                </span>
              </button>
            )}
            <button className="sd-launch-row" onClick={() => setView("files")}>
              <FolderIcon size={18} className="sd-launch-ico" />
              <span className="sd-launch-label">文件</span>
              {files.length > 0 && <span className="rev-count">{files.length}</span>}
              <span className="sd-launch-kbd">⌘P</span>
            </button>
            <button className="sd-launch-row" onClick={() => setView("preview")}>
              <GlobeIcon size={18} className="sd-launch-ico" />
              <span className="sd-launch-label">浏览器</span>
              <span className="sd-launch-kbd">⌘T</span>
            </button>
            <button className="sd-launch-row" onClick={() => setView("terminal")}>
              <TerminalIcon size={18} className="sd-launch-ico" />
              <span className="sd-launch-label">终端</span>
            </button>
          </div>
        )}
        {view === "diff" && git && <DiffTab git={git} />}
        {view === "files" && (
          <FilesTab files={files} readFile={readFile} emptyHint={filesEmpty} openTarget={repo ? null : target} />
        )}
        {view === "terminal" && <TerminalTab msgs={msgs} history={termHistory} onRun={runCommand} />}
        {view === "preview" && <PreviewTab url={previewUrl} onClear={onClearPreview} />}
      </div>
    </aside>
  );
}

// ===== 文件 tab（工件列表 + 文件树统一）=====
function FilesTab({
  files,
  readFile,
  emptyHint,
  openTarget,
}: {
  files: WsEntry[];
  readFile: (path: string) => Promise<FilePreview>;
  emptyHint: ReactNode;
  /** 外部请求打开的文件（点「文件改动」卡时定位预览）；nonce 让连点同一文件也触发。 */
  openTarget?: { path: string; nonce: number } | null;
}) {
  const [sel, setSel] = useState<string | null>(null);
  const [data, setData] = useState<FilePreview | null>(null);
  const [mode, setMode] = useState<"code" | "preview">("code");
  const handledRef = useRef<number | null>(null);

  // 选中文件刷新后消失（被删/改名）→ 收起预览。
  useEffect(() => {
    if (sel && !files.some((f) => f.path === sel)) {
      setSel(null);
      setData(null);
    }
  }, [files, sel]);

  // 外部请求打开某文件（文件改动卡）→ 选中并预览。按 nonce 去重（防文件列表轮询重复触发；连点同一文件 nonce 变 → 重新打开）。
  useEffect(() => {
    if (!openTarget || handledRef.current === openTarget.nonce) return;
    // 路径优先精确匹配；不中（相对/绝对形式不一）则退化到 basename 匹配，避免静默无反应。
    const want = openTarget.path;
    const base = want.split(/[/\\]/).pop();
    const hit = files.find((f) => f.path === want) ?? files.find((f) => f.path.split(/[/\\]/).pop() === base);
    if (!hit) return;
    handledRef.current = openTarget.nonce;
    setSel(hit.path);
    setData(null);
    setMode(/\.html?$/i.test(hit.path) ? "preview" : "code");
    readFile(hit.path)
      .then(setData)
      .catch(() => setData({ size: 0 }));
  }, [openTarget, files, readFile]);

  const openFile = async (p: string) => {
    if (sel === p) {
      setSel(null);
      setData(null);
      return;
    }
    setSel(p);
    setData(null);
    setMode(/\.html?$/i.test(p) ? "preview" : "code");
    try {
      setData(await readFile(p));
    } catch {
      setData({ size: 0 });
    }
  };

  if (files.length === 0) return <div className="rev-empty">{emptyHint}</div>;
  return (
    <div className="rev-scroll">
      {files.map((f) => {
        const isOpen = sel === f.path;
        return (
          <div key={f.path} className="af-file">
            <div className={`af-file-head ${isOpen ? "open" : ""}`} onClick={() => void openFile(f.path)}>
              <ChevronIcon size={13} className={`chev ${isOpen ? "open" : ""}`} />
              {fileIconFor(f.path)}
              <span className="af-path" title={f.path}>
                {f.path}
              </span>
              {f.size != null && <span className="af-size">{fmtBytes(f.size)}</span>}
            </div>
            {isOpen && <FilePreviewView path={f.path} data={data} mode={mode} setMode={setMode} />}
          </div>
        );
      })}
    </div>
  );
}

export function FilePreviewView({
  path,
  data,
  mode,
  setMode,
}: {
  path: string;
  data: FilePreview | null;
  mode: "code" | "preview";
  setMode: (m: "code" | "preview") => void;
}) {
  if (!data) return <div className="af-loading">加载中…</div>;
  if (data.binary) return <div className="af-bin">二进制文件，无法预览 · {fmtBytes(data.size)}</div>;
  const content = data.content ?? "";
  const isHtml = /\.html?$/i.test(path);
  return (
    <div className="af-body">
      <div className="af-toolbar">
        {isHtml && (
          <div className="af-seg">
            <button className={mode === "preview" ? "on" : ""} onClick={() => setMode("preview")}>
              预览
            </button>
            <button className={mode === "code" ? "on" : ""} onClick={() => setMode("code")}>
              源码
            </button>
          </div>
        )}
        <span className="bar-spacer" />
        <CopyButton text={content} />
      </div>
      {isHtml && mode === "preview" ? (
        <iframe className="af-frame" sandbox="allow-scripts" title={path} srcDoc={content} />
      ) : (
        <pre className="af-code">
          <code>{content || "（空文件）"}</code>
        </pre>
      )}
      {data.truncated && <div className="af-trunc">内容较大，已截断显示。</div>}
    </div>
  );
}

// ===== 终端 tab：看 AI 运行的命令 + 自己跑命令 =====
function TerminalTab({
  msgs,
  history,
  onRun,
}: {
  msgs: UiMsg[];
  history: TermEntry[];
  onRun: (command: string) => Promise<void>;
}) {
  const [cmd, setCmd] = useState("");
  const [running, setRunning] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // AI 最近一次 run_command（作为上下文展示在顶部）。
  let aiLast: { output?: string; result?: string; args: string } | undefined;
  for (const m of msgs) for (const b of m.blocks ?? []) if (b.kind === "tool" && b.tool.name === "run_command") aiLast = b.tool;
  let aiCmd = "";
  try {
    aiCmd = (JSON.parse(aiLast?.args || "{}") as { command?: string }).command ?? "";
  } catch {
    /* ignore */
  }

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [history, running]);

  const submit = async () => {
    const c = cmd.trim();
    if (!c || running) return;
    setCmd("");
    setRunning(true);
    try {
      await onRun(c);
    } finally {
      setRunning(false);
      inputRef.current?.focus();
    }
  };

  return (
    <div className="term-tab">
      <div className="term-scroll" ref={scrollRef}>
        {aiLast && (
          <div className="term-entry term-ai">
            <div className="term-cmd">
              <span className="term-tag">AI</span># {aiCmd}
            </div>
            <pre className="term-out">{aiLast.output || aiLast.result || "（无输出）"}</pre>
          </div>
        )}
        {history.map((e, i) => (
          <div key={i} className="term-entry">
            <div className="term-cmd">
              <span className="term-dollar">$</span> {e.cmd}
              {e.code != null && e.code !== 0 && <span className="term-code">exit {e.code}</span>}
            </div>
            <pre className="term-out">{e.output}</pre>
            {e.truncated && <div className="term-trunc">输出过长，已截断。</div>}
          </div>
        ))}
        {!aiLast && history.length === 0 && (
          <div className="rev-empty">在下方输入命令并回车即可在此工作目录执行；AI 运行过的命令也会出现在这里。</div>
        )}
      </div>
      <div className="term-input">
        <span className="term-dollar">$</span>
        <input
          ref={inputRef}
          value={cmd}
          placeholder={running ? "执行中…" : "输入命令并回车…"}
          disabled={running}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <button className="fv-btn" title="运行" disabled={running || !cmd.trim()} onClick={() => void submit()}>
          <EnterIcon size={14} />
        </button>
      </div>
    </div>
  );
}

// ===== 预览 tab：网页（点链接/来源）iframe 预览 =====
function PreviewTab({ url, onClear }: { url: string | null; onClear: () => void }) {
  const [nonce, setNonce] = useState(0);
  const [copied, setCopied] = useState(false);
  if (!url)
    return (
      <div className="rev-empty">
        点消息里的来源或链接，会在这里内联预览网页（不会把整个应用导航走）。部分站点禁止被内嵌时显示空白，可复制链接到浏览器打开。
      </div>
    );
  return (
    <>
      <div className="rev-head sd-url">
        <GlobeIcon size={14} />
        <span className="wpv-url" title={url}>
          {url}
        </span>
        <span className="bar-spacer" />
        <button
          className="fv-btn"
          title="复制链接"
          onClick={() => {
            void navigator.clipboard.writeText(url);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
        </button>
        <button className="fv-btn" title="刷新" onClick={() => setNonce((n) => n + 1)}>
          <RefreshIcon size={13} />
        </button>
        <button className="fv-btn" title="清空预览" onClick={onClear}>
          <XIcon size={14} />
        </button>
      </div>
      <iframe
        key={`${url}#${nonce}`}
        className="wpv-frame"
        src={url}
        title="网页预览"
        referrerPolicy="no-referrer"
        sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
      />
    </>
  );
}

// ===== 改动 tab：git 审查（分组/hunk/commit/push/pull/history）=====
function DiffTab({ git }: { git: GitContext }) {
  const { projectId, status, remote, onRefresh } = git;
  const [commitMsg, setCommitMsg] = useState("");
  const [committing, setCommitting] = useState(false);
  const [netBusy, setNetBusy] = useState(false);
  const [netNote, setNetNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [historyNonce, setHistoryNonce] = useState(0);
  const staged = status.files.filter((f) => f.staged);
  const unstaged = status.files.filter((f) => f.unstaged);

  const act = async (fn: () => Promise<unknown>) => {
    await fn().catch(() => {});
    await onRefresh();
  };

  const commit = async () => {
    if (!commitMsg.trim() || staged.length === 0) return;
    setCommitting(true);
    try {
      const r = await getClient().gitCommit(projectId, commitMsg.trim());
      if (r.ok) {
        setCommitMsg("");
        setHistoryNonce((n) => n + 1);
      } else alert(`提交失败：${r.error ?? ""}`);
      await onRefresh();
    } finally {
      setCommitting(false);
    }
  };

  const net = async (kind: "push" | "pull") => {
    setNetBusy(true);
    setNetNote({ ok: true, text: kind === "push" ? "推送中…" : "拉取中…" });
    try {
      const r = kind === "push" ? await getClient().gitPush(projectId) : await getClient().gitPull(projectId);
      setNetNote({ ok: r.ok, text: r.message || (r.ok ? "完成" : "失败") });
      if (kind === "pull") setHistoryNonce((n) => n + 1);
      await onRefresh();
    } catch (e) {
      setNetNote({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setNetBusy(false);
    }
  };

  if (!status.repo)
    return (
      <div className="rev-empty">
        该目录不是 git 仓库。运行 <code>git init</code> 后即可在此审阅改动。
      </div>
    );

  return (
    <>
      {remote.hasRemote && (
        <div className="rev-remote">
          <span className="rev-remote-info" title={remote.upstream}>
            {remote.hasUpstream ? remote.upstream : "未设上游"}
            {(remote.ahead > 0 || remote.behind > 0) && (
              <span className="rev-counts">
                {remote.ahead > 0 && <span className="add">↑{remote.ahead}</span>}
                {remote.behind > 0 && <span className="del">↓{remote.behind}</span>}
              </span>
            )}
          </span>
          <span className="bar-spacer" />
          <button className="rev-act" disabled={netBusy} onClick={() => void net("pull")} title="git pull --ff-only">
            <DownloadIcon size={12} /> 拉取
          </button>
          <button className="rev-act" disabled={netBusy} onClick={() => void net("push")} title="git push">
            <UploadIcon size={12} /> 推送
          </button>
        </div>
      )}
      {netNote && <div className={`rev-net-note ${netNote.ok ? "" : "err"}`}>{netNote.text}</div>}

      <div className="rev-scroll">
        {status.files.length === 0 && <div className="rev-empty">工作区干净，无改动。</div>}

        {unstaged.length > 0 && (
          <Group
            title="未暂存"
            count={unstaged.length}
            files={unstaged}
            projectId={projectId}
            staged={false}
            actions={
              <>
                <button className="rev-act" onClick={() => void act(() => getClient().gitStage(projectId))}>
                  全部暂存
                </button>
                <button className="rev-act danger" onClick={() => void act(() => getClient().gitRevert(projectId))}>
                  <UndoIcon size={12} /> 全部还原
                </button>
              </>
            }
            onAct={act}
          />
        )}

        {staged.length > 0 && (
          <Group
            title="已暂存"
            count={staged.length}
            files={staged}
            projectId={projectId}
            staged
            actions={
              <button className="rev-act" onClick={() => void act(() => getClient().gitUnstage(projectId))}>
                全部取消暂存
              </button>
            }
            onAct={act}
          />
        )}

        <CommitHistory projectId={projectId} nonce={historyNonce} />
      </div>

      {staged.length > 0 && (
        <div className="rev-commit">
          <textarea placeholder="提交说明…" value={commitMsg} rows={2} onChange={(e) => setCommitMsg(e.target.value)} />
          <button disabled={!commitMsg.trim() || committing} onClick={() => void commit()}>
            <CommitIcon size={14} /> 提交 {staged.length} 个文件
          </button>
        </div>
      )}
    </>
  );
}

function CommitHistory({ projectId, nonce }: { projectId: string; nonce: number }) {
  const [open, setOpen] = useState(false);
  const [commits, setCommits] = useState<GitCommit[] | null>(null);

  const load = useCallback(async () => {
    try {
      setCommits(await getClient().gitLog(projectId, 30));
    } catch {
      setCommits([]);
    }
  }, [projectId]);

  useEffect(() => {
    if (open) void load();
  }, [open, nonce, load]);

  return (
    <div className="rev-group">
      <div className="rev-group-head rev-history-head" onClick={() => setOpen((v) => !v)}>
        <span className="rev-group-title">
          <ChevronIcon size={13} className={`chev ${open ? "open" : ""}`} /> 提交历史
        </span>
      </div>
      {open &&
        (commits === null ? (
          <div className="rev-empty">加载中…</div>
        ) : commits.length === 0 ? (
          <div className="rev-empty">还没有提交。</div>
        ) : (
          commits.map((c) => (
            <div key={c.hash} className="rev-commit-row" title={`${c.hash}\n${c.author} · ${c.relDate}`}>
              <code className="rev-chash">{c.shortHash}</code>
              <span className="rev-csubject">{c.subject}</span>
              <span className="rev-cmeta">{c.relDate}</span>
            </div>
          ))
        ))}
    </div>
  );
}

function Group({
  title,
  count,
  files,
  projectId,
  staged,
  actions,
  onAct,
}: {
  title: string;
  count: number;
  files: GitFile[];
  projectId: string;
  staged: boolean;
  actions: ReactNode;
  onAct: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  return (
    <div className="rev-group">
      <div className="rev-group-head">
        <span className="rev-group-title">
          {title} <span className="rev-count">{count}</span>
        </span>
        <span className="bar-spacer" />
        {actions}
      </div>
      {files.map((f) => (
        <FileRow
          key={`${staged ? "s" : "u"}:${f.path}:${f.adds}-${f.dels}`}
          file={f}
          projectId={projectId}
          staged={staged}
          onAct={onAct}
        />
      ))}
    </div>
  );
}

function FileRow({
  file,
  projectId,
  staged,
  onAct,
}: {
  file: GitFile;
  projectId: string;
  staged: boolean;
  onAct: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [diff, setDiff] = useState<string | null>(null);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && diff == null) {
      try {
        setDiff(await getClient().gitDiff(projectId, file.path, staged));
      } catch {
        setDiff("");
      }
    }
  };

  return (
    <div className="rev-file">
      <div className="rev-file-head" onClick={() => void toggle()}>
        <ChevronIcon size={13} className={`chev ${open ? "open" : ""}`} />
        <span className="rev-path" title={file.path}>
          {file.untracked ? "● " : ""}
          {file.path}
        </span>
        <span className="rev-stat">
          <span className="add">+{file.adds}</span> <span className="del">-{file.dels}</span>
        </span>
        <span className="rev-file-acts" onClick={(e) => e.stopPropagation()}>
          {staged ? (
            <button title="取消暂存" onClick={() => void onAct(() => getClient().gitUnstage(projectId, [file.path]))}>
              −
            </button>
          ) : (
            <>
              <button title="暂存" onClick={() => void onAct(() => getClient().gitStage(projectId, [file.path]))}>
                ＋
              </button>
              <button
                className="danger"
                title="还原"
                onClick={() => void onAct(() => getClient().gitRevert(projectId, [file.path]))}
              >
                <UndoIcon size={12} />
              </button>
            </>
          )}
        </span>
      </div>
      {open && diff != null && (
        <DiffView text={diff} projectId={projectId} path={file.path} staged={staged} untracked={file.untracked} onAct={onAct} />
      )}
    </div>
  );
}

interface DiffRow {
  type: "hunk" | "ctx" | "add" | "del";
  oldNo?: number;
  newNo?: number;
  text: string;
}

/** 解析 git unified diff → 带新旧行号的行（@@ hunk 驱动）。 */
function parseUnifiedDiff(text: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ "))
      continue;
    if (line.startsWith("@@")) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m) {
        oldNo = Number(m[1]);
        newNo = Number(m[2]);
      }
      rows.push({ type: "hunk", text: line });
      continue;
    }
    if (line.startsWith("\\")) continue; // \ No newline at end of file
    if (line.startsWith("+")) rows.push({ type: "add", newNo: newNo++, text: line.slice(1) });
    else if (line.startsWith("-")) rows.push({ type: "del", oldNo: oldNo++, text: line.slice(1) });
    else rows.push({ type: "ctx", oldNo: oldNo++, newNo: newNo++, text: line.startsWith(" ") ? line.slice(1) : line });
  }
  return rows;
}

function DiffView({
  text,
  projectId,
  path,
  staged,
  untracked,
  onAct,
}: {
  text: string;
  projectId: string;
  path: string;
  staged: boolean;
  untracked: boolean;
  onAct: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  if (!text.trim()) return <div className="diff-empty">（无文本 diff）</div>;
  const rows = parseUnifiedDiff(text);
  let hunk = -1;
  const hunkOp = (hi: number, op: "stage" | "unstage" | "discard") =>
    void onAct(() => getClient().gitHunk(projectId, path, hi, op));
  return (
    <div className="diffview">
      {rows.map((r, i) => {
        if (r.type === "hunk") {
          hunk += 1;
          const hi = hunk;
          return (
            <div key={i} className="dv-hunk">
              <span className="dv-hunk-line">{r.text}</span>
              {!untracked && (
                <span className="dv-hunk-acts">
                  {staged ? (
                    <button onClick={() => hunkOp(hi, "unstage")}>取消暂存块</button>
                  ) : (
                    <>
                      <button onClick={() => hunkOp(hi, "stage")}>暂存块</button>
                      <button className="danger" onClick={() => hunkOp(hi, "discard")} title="从工作区丢弃此块（不可撤销）">
                        丢弃块
                      </button>
                    </>
                  )}
                </span>
              )}
            </div>
          );
        }
        return (
          <div key={i} className={`dv-row ${r.type}`}>
            <span className="dv-gutter">{r.oldNo ?? ""}</span>
            <span className="dv-gutter">{r.newNo ?? ""}</span>
            <span className="dv-sign">{r.type === "add" ? "+" : r.type === "del" ? "-" : " "}</span>
            <span className="dv-code">{r.text || " "}</span>
          </div>
        );
      })}
    </div>
  );
}
