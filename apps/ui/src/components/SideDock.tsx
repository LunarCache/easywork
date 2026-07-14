import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { ExecResult, GitCommit, GitFile, GitRemoteInfo, GitStatus, WsEntry } from "@ew/sdk";
import { getClient } from "../lib/client.js";
import { useConfirm } from "./ConfirmDialog.js";
import { FileViewer } from "./FileViewer.js";
import { fileType, formatFileSize } from "../lib/filetype.js";
import { matchFileTarget } from "../lib/file-target.js";
import { resolvePreviewKind } from "../lib/preview.js";
import type { UiMsg } from "../lib/agent-stream.js";
import {
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
  PlusIcon,
  RefreshIcon,
  TerminalIcon,
  UndoIcon,
  UploadIcon,
  XIcon,
} from "../icons.js";

/** git 上下文：提供则出现「改动」tab（工作区模式）。 */
export interface GitContext {
  projectId: string;
  status: GitStatus;
  remote: GitRemoteInfo;
  onRefresh: () => Promise<void>;
}

type Tab = "diff" | "files" | "terminal" | "preview";

const TAB_META: Record<Tab, { label: string; icon: () => ReactNode }> = {
  diff: { label: "改动", icon: () => <FileIcon size={14} /> },
  files: { label: "文件", icon: () => <FolderIcon size={14} /> },
  terminal: { label: "终端", icon: () => <TerminalIcon size={14} /> },
  preview: { label: "浏览器", icon: () => <GlobeIcon size={14} /> },
};
const TAB_ORDER: Tab[] = ["diff", "terminal", "preview", "files"];

export interface BrowserTarget {
  url: string;
  nonce: number;
}

type BrowserPage =
  | { kind: "url"; url: string }
  | { kind: "html"; name: string; html: string };

const DOCK_WIDTH_KEY = "easywork.side-dock.width";
const DOCK_WIDTH_DEFAULT = 420;
const DOCK_WIDTH_MIN = 320;
const DOCK_WIDTH_MAX = 760;

function clampDockWidth(width: number): number {
  return Math.min(DOCK_WIDTH_MAX, Math.max(DOCK_WIDTH_MIN, width));
}

function readDockWidth(): number {
  try {
    const stored = Number(localStorage.getItem(DOCK_WIDTH_KEY));
    return Number.isFinite(stored) && stored > 0 ? clampDockWidth(stored) : DOCK_WIDTH_DEFAULT;
  } catch {
    return DOCK_WIDTH_DEFAULT;
  }
}

function persistDockWidth(width: number): void {
  try {
    localStorage.setItem(DOCK_WIDTH_KEY, String(width));
  } catch {
    /* ignore */
  }
}

function normalizeBrowserAddress(value: string): string | null {
  const input = value.trim();
  if (!input) return null;
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : `https://${input}`;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function fileIconFor(p: string) {
  const ft = fileType(p);
  return <ft.Icon size={14} style={{ color: ft.color }} />;
}

function isHtmlFile(path: string): boolean {
  return resolvePreviewKind(path) === "html";
}

function DockEmpty({ children }: { children: ReactNode }) {
  return <div className="rev-empty sd-empty">{children}</div>;
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
  previewScope,
  previewId,
  onFilesRefresh,
  onRevealDir,
  filesEmpty,
  msgs,
  exec,
  browserTarget,
  onClearPreview,
  git,
  target,
}: {
  open: boolean;
  onClose: () => void;
  files: WsEntry[];
  /** 统一文件预览的作用域 + id（FileViewer 据此走 /files/meta + /files/raw）。 */
  previewScope: "workspace" | "chat";
  previewId: string;
  onFilesRefresh: () => void;
  onRevealDir: () => void;
  filesEmpty: ReactNode;
  msgs: UiMsg[];
  exec: (command: string) => Promise<ExecResult>;
  /** 消息链接触发的一次浏览器导航；nonce 使重复点击同一 URL 仍能重新激活。 */
  browserTarget: BrowserTarget | null;
  onClearPreview: () => void;
  git?: GitContext;
  /** 外部请求查看某文件的改动（点「文件改动」卡）：跳到 改动(工作区)/文件(对话) 视图。 */
  target?: { path: string; nonce: number } | null;
}) {
  const initialView: Tab = git ? "diff" : "files";
  const [view, setView] = useState<Tab>(initialView);
  const [openViews, setOpenViews] = useState<Tab[]>([initialView]);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [browserPage, setBrowserPage] = useState<BrowserPage | null>(() => {
    const url = browserTarget ? normalizeBrowserAddress(browserTarget.url) : null;
    return url ? { kind: "url", url } : null;
  });
  const [maxed, setMaxed] = useState(false);
  const [dockWidth, setDockWidth] = useState(readDockWidth);
  const [termHistory, setTermHistory] = useState<TermEntry[]>([]);
  const [toolbarHost, setToolbarHost] = useState<HTMLElement | null>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const targetHandledRef = useRef<number | null>(null);
  const repo = !!git?.status.repo;
  // repo 经 ref 读取：仅 target.nonce 变化（点击改动卡）才切视图；
  // git 状态后台刷新（repo false→true）不应把用户从当前视图（终端/预览）拽回 diff。
  const repoRef = useRef(repo);
  repoRef.current = repo;

  const activateView = useCallback((next: Tab) => {
    setOpenViews((current) => (current.includes(next) ? current : [...current, next]));
    setView(next);
    setAddMenuOpen(false);
  }, []);

  useEffect(() => {
    setToolbarHost(document.getElementById("side-dock-titlebar-host"));
  }, []);

  useEffect(() => {
    if (!open || openViews.length > 0) return;
    setOpenViews([initialView]);
    setView(initialView);
  }, [initialView, open, openViews.length]);

  const closeView = useCallback((closing: Tab) => {
    const index = openViews.indexOf(closing);
    if (index < 0) return;
    const remaining = openViews.filter((tab) => tab !== closing);
    setOpenViews(remaining);
    if (closing === "preview") {
      setBrowserPage(null);
      onClearPreview();
    }
    if (view === closing && remaining.length > 0) {
      setView(remaining[Math.min(index, remaining.length - 1)]!);
    }
    if (remaining.length === 0) onClose();
  }, [onClearPreview, onClose, openViews, view]);

  const openHtmlFile = useCallback(async (path: string) => {
    const resolvedPath = matchFileTarget(files, path)?.path ?? path;
    try {
      const meta = await getClient().previewMeta(previewScope, previewId, resolvedPath);
      if (meta.kind !== "html") {
        activateView("files");
        return;
      }
      setBrowserPage({ kind: "html", name: meta.name, html: meta.text ?? "" });
      activateView("preview");
    } catch {
      activateView("files");
    }
  }, [activateView, files, previewId, previewScope]);

  useEffect(() => {
    if (!addMenuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!addMenuRef.current?.contains(event.target as Node)) setAddMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAddMenuOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [addMenuOpen]);

  // 「文件改动」卡点击 → git 仓库跳到 diff；否则跳到「文件」视图（FilesTab 按 nonce 定位文件）。
  useEffect(() => {
    if (!target || targetHandledRef.current === target.nonce) return;
    targetHandledRef.current = target.nonce;
    if (isHtmlFile(target.path)) {
      void openHtmlFile(target.path);
      return;
    }
    activateView(repoRef.current ? "diff" : "files");
  }, [target?.nonce, activateView, openHtmlFile]);

  // 点消息里的链接/来源 → 校验地址后自动进「浏览器」（开关由父组件负责）。
  useEffect(() => {
    if (!browserTarget) return;
    const url = normalizeBrowserAddress(browserTarget.url);
    if (!url) return;
    setBrowserPage({ kind: "url", url });
    activateView("preview");
  }, [browserTarget?.nonce, activateView]);

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

  const onResizeStart = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = dockWidth;
    let width = startWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const move = (moveEvent: MouseEvent) => {
      width = clampDockWidth(startWidth + startX - moveEvent.clientX);
      setDockWidth(width);
    };
    const up = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      persistDockWidth(width);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const resizeByKeyboard = (delta: number) => {
    setDockWidth((current) => {
      const width = clampDockWidth(current + delta);
      persistDockWidth(width);
      return width;
    });
  };

  const titlebarTabs = open && toolbarHost
    ? createPortal(
      <div className="sd-titlebar-toolbar" data-tauri-drag-region>
        <div className="sd-open-tabs" role="tablist" aria-label="已打开的工作台视图" data-tauri-drag-region>
          {openViews.map((tab) => (
            <div key={tab} className={`sd-tab-shell ${view === tab ? "on" : ""}`} data-tauri-drag-region>
              <button
                className={`sd-tab ${view === tab ? "on" : ""}`}
                data-testid={`side-dock-tab-${tab}`}
                role="tab"
                aria-selected={view === tab}
                onClick={() => activateView(tab)}
              >
                {TAB_META[tab].icon()}
                <span>{TAB_META[tab].label}</span>
                {tab === "files" && files.length > 0 && <span className="rev-count">{files.length}</span>}
              </button>
              <button
                type="button"
                className="sd-tab-close"
                title={`关闭${TAB_META[tab].label}标签`}
                aria-label={`关闭${TAB_META[tab].label}标签`}
                onClick={() => closeView(tab)}
              >
                <XIcon size={12} />
              </button>
            </div>
          ))}
        </div>
        <div className="sd-add-wrap" ref={addMenuRef} data-tauri-drag-region>
          <button
            className={`fv-btn sd-add ${addMenuOpen ? "on" : ""}`}
            data-testid="side-dock-add-view"
            title="打开工作台视图"
            aria-label="打开工作台视图"
            aria-expanded={addMenuOpen}
            onClick={() => setAddMenuOpen((current) => !current)}
          >
            <PlusIcon size={16} />
          </button>
          {addMenuOpen && (
            <div className="sd-view-menu" data-testid="side-dock-view-menu" role="menu">
              {TAB_ORDER.filter((tab) => tab !== "diff" || git).map((tab) => (
                <button type="button" key={tab} role="menuitem" onClick={() => activateView(tab)}>
                  {TAB_META[tab].icon()}
                  <span>{TAB_META[tab].label}</span>
                  {openViews.includes(tab) && <CheckIcon size={14} className="sd-menu-check" />}
                </button>
              ))}
            </div>
          )}
        </div>
        <button className="fv-btn sd-max" title={maxed ? "还原" : "放大到窗口"} onClick={() => setMaxed((v) => !v)}>
          {maxed ? <MinimizeIcon size={13} /> : <MaximizeIcon size={13} />}
        </button>
      </div>,
      toolbarHost,
    )
    : null;

  return (
    <>
      {titlebarTabs}
      <aside
      className={`side-dock ${open ? "open" : ""} ${maxed ? "max" : ""}`}
      data-testid="side-dock"
      style={maxed ? undefined : { width: dockWidth }}
    >
      <div
        className="sd-resize-handle"
        data-testid="side-dock-resize-handle"
        role="separator"
        aria-label="调整工作台宽度"
        aria-orientation="vertical"
        aria-valuemin={DOCK_WIDTH_MIN}
        aria-valuemax={DOCK_WIDTH_MAX}
        aria-valuenow={dockWidth}
        tabIndex={0}
        onMouseDown={onResizeStart}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") {
            event.preventDefault();
            resizeByKeyboard(16);
          } else if (event.key === "ArrowRight") {
            event.preventDefault();
            resizeByKeyboard(-16);
          }
        }}
      />
      <div className="sd-body">
        {view === "diff" && git && <DiffTab git={git} />}
        {view === "files" && (
          <FilesTab
            files={files}
            scope={previewScope}
            id={previewId}
            emptyHint={filesEmpty}
            openTarget={repo ? null : target}
            maxed={maxed}
            onRefresh={onFilesRefresh}
            onRevealDir={onRevealDir}
            onOpenHtml={(path) => void openHtmlFile(path)}
          />
        )}
        {view === "terminal" && <TerminalTab msgs={msgs} history={termHistory} onRun={runCommand} />}
        {view === "preview" && (
          <PreviewTab
            page={browserPage}
            onNavigate={(url) => setBrowserPage({ kind: "url", url })}
            onClear={() => {
              setBrowserPage(null);
              onClearPreview();
            }}
          />
        )}
      </div>
      </aside>
    </>
  );
}

// ===== 文件 tab（工件列表 + 文件树统一）；预览交给统一 FileViewer =====
function FilesTab({
  files,
  scope,
  id,
  emptyHint,
  openTarget,
  maxed,
  onRefresh,
  onRevealDir,
  onOpenHtml,
}: {
  files: WsEntry[];
  scope: "workspace" | "chat";
  id: string;
  emptyHint: ReactNode;
  /** 外部请求打开的文件（点「文件改动」卡时定位预览）；nonce 让连点同一文件也触发。 */
  openTarget?: { path: string; nonce: number } | null;
  maxed: boolean;
  onRefresh: () => void;
  onRevealDir: () => void;
  onOpenHtml: (path: string) => void;
}) {
  const [sel, setSel] = useState<string | null>(null);
  const handledRef = useRef<number | null>(null);
  const targetFile = useMemo(
    () => (openTarget ? matchFileTarget(files, openTarget.path) : undefined),
    [files, openTarget],
  );
  // 交付卡可能指向超过列表默认深度的文件；合成一条可预览项，点击不依赖 FilesTab 是否已列到它。
  const visibleFiles = useMemo(() => {
    if (!openTarget || targetFile) return files;
    return [{ path: openTarget.path, type: "file" as const }, ...files];
  }, [files, openTarget, targetFile]);

  // 选中文件刷新后消失（被删/改名）→ 收起预览。
  useEffect(() => {
    if (sel && !visibleFiles.some((f) => f.path === sel)) setSel(null);
  }, [visibleFiles, sel]);

  // 外部请求打开某文件（文件改动卡）→ 选中。按 nonce 去重（防文件列表轮询重复触发；连点同一文件 nonce 变 → 重新打开）。
  useEffect(() => {
    if (!openTarget || handledRef.current === openTarget.nonce) return;
    handledRef.current = openTarget.nonce;
    if (isHtmlFile(openTarget.path)) {
      setSel(null);
      return;
    }
    setSel(targetFile?.path ?? openTarget.path);
  }, [openTarget, targetFile]);

  const openFile = (path: string) => {
    if (isHtmlFile(path)) {
      setSel(null);
      onOpenHtml(path);
      return;
    }
    setSel(path);
  };

  const fileList = (
    <div className="files-list">
      <div className="rev-head files-head">
        <span>文件</span>
        {visibleFiles.length > 0 && <span className="rev-count">{visibleFiles.length}</span>}
        <span className="bar-spacer" />
        <button className="fv-btn" title="在文件管理器中打开目录" onClick={onRevealDir}>
          <FolderIcon size={14} />
        </button>
        <button className="fv-btn" title="刷新" onClick={onRefresh}>
          <RefreshIcon size={13} />
        </button>
      </div>
      <div className="rev-scroll af-scroll">
        {visibleFiles.length === 0 && <DockEmpty>{emptyHint}</DockEmpty>}
        {visibleFiles.map((file) => (
          <button
            type="button"
            key={file.path}
            className={`af-file ${sel === file.path ? "active" : ""}`}
            onClick={() => openFile(file.path)}
          >
            {fileIconFor(file.path)}
            <span className="af-path" title={file.path}>{file.path}</span>
            {file.size != null && <span className="af-size">{formatFileSize(file.size)}</span>}
          </button>
        ))}
      </div>
    </div>
  );
  const fileViewer = sel ? (
    <FileViewer
      key={sel}
      source={{ kind: "fs", scope, id, path: sel }}
      onBack={maxed ? undefined : () => setSel(null)}
    />
  ) : (
    <DockEmpty>从文件列表中选择一个文件进行预览。</DockEmpty>
  );

  if (maxed) {
    return (
      <div className="files-split">
        <nav className="files-nav" aria-label="文件列表">{fileList}</nav>
        <div className="files-detail">{fileViewer}</div>
      </div>
    );
  }
  return sel ? <div className="files-detail">{fileViewer}</div> : fileList;
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
        {!aiLast && history.length === 0 && <DockEmpty>输入命令后，结果会显示在这里。</DockEmpty>}
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

// ===== 浏览器 tab：消息链接、HTML 文件或用户输入地址 → iframe 浏览 =====
function PreviewTab({
  page,
  onNavigate,
  onClear,
}: {
  page: BrowserPage | null;
  onNavigate: (url: string) => void;
  onClear: () => void;
}) {
  const [nonce, setNonce] = useState(0);
  const [copied, setCopied] = useState(false);
  const [draft, setDraft] = useState(page?.kind === "url" ? page.url : page?.name ?? "");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(page?.kind === "url" ? page.url : page?.name ?? "");
    setError(null);
  }, [page]);

  const navigate = () => {
    const next = normalizeBrowserAddress(draft);
    if (!next) {
      setError("请输入有效的 http(s) 地址");
      return;
    }
    setError(null);
    setDraft(next);
    onNavigate(next);
  };

  return (
    <div className="preview-tab">
      <div className="rev-head sd-url">
        <GlobeIcon size={14} />
        <input
          className="wpv-address"
          aria-label="浏览器地址"
          value={draft}
          placeholder="输入网址，例如 example.com"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              navigate();
            }
          }}
        />
        <button className="fv-btn" title="前往" onClick={navigate} disabled={!draft.trim()}>
          <EnterIcon size={14} />
        </button>
        {page && (
          <>
            <button
              className="fv-btn"
              title="复制地址"
              onClick={() => {
                void navigator.clipboard.writeText(page.kind === "url" ? page.url : page.name);
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              }}
            >
              {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
            </button>
            <button className="fv-btn" title="刷新" onClick={() => setNonce((n) => n + 1)}>
              <RefreshIcon size={13} />
            </button>
            <button className="fv-btn" title="清空地址" onClick={onClear}>
              <XIcon size={14} />
            </button>
          </>
        )}
      </div>
      {error && <div className="wpv-error">{error}</div>}
      {page?.kind === "url" ? (
        <iframe
          key={`${page.url}#${nonce}`}
          className="wpv-frame"
          src={page.url}
          title="网页预览"
          referrerPolicy="no-referrer"
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
        />
      ) : page?.kind === "html" ? (
        <iframe
          key={`${page.name}#${nonce}`}
          className="wpv-frame"
          srcDoc={page.html}
          title={page.name}
          sandbox="allow-scripts allow-forms allow-modals"
        />
      ) : (
        <DockEmpty>输入网址，或打开消息链接 / HTML 文件后在这里浏览。</DockEmpty>
      )}
    </div>
  );
}

// ===== 改动 tab：git 审查（分组/hunk/commit/push/pull/history）=====
function DiffTab({ git }: { git: GitContext }) {
  const { alert: showAlert, dialog: confirmDialog } = useConfirm();
  const { projectId, status, remote, onRefresh } = git;
  const [commitMsg, setCommitMsg] = useState("");
  const [committing, setCommitting] = useState(false);
  const [netBusy, setNetBusy] = useState(false);
  const [netNote, setNetNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [historyNonce, setHistoryNonce] = useState(0);
  const staged = status.files.filter((f) => f.staged);
  const unstaged = status.files.filter((f) => f.unstaged);
  const adds = status.files.reduce((sum, file) => sum + file.adds, 0);
  const dels = status.files.reduce((sum, file) => sum + file.dels, 0);

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
      } else {
        await showAlert({ title: "提交失败", body: r.error ?? "未知错误" });
      }
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

  const summary = (
    <div className="rev-head">
      <span>当前改动</span>
      {(adds > 0 || dels > 0) && (
        <span className="rev-stat">
          <span className="add">+{adds}</span> <span className="del">-{dels}</span>
        </span>
      )}
      <span className="bar-spacer" />
      <button className="fv-btn" title="刷新" onClick={() => void onRefresh()}>
        <RefreshIcon size={13} />
      </button>
    </div>
  );

  if (!status.repo)
    return (
      <>
        {summary}
        <DockEmpty>
          当前目录不是 Git 仓库。运行 <code>git init</code> 后即可审阅改动。
        </DockEmpty>
      </>
    );

  return (
    <>
      {summary}
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
        {status.files.length === 0 && <DockEmpty>工作区干净，无改动。</DockEmpty>}

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
      {confirmDialog}
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
