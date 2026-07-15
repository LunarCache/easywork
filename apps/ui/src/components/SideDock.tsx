import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { GitCommit, GitFile, GitRemoteInfo, GitStatus, WsEntry } from "@ew/sdk";
import { getClient } from "../lib/client.js";
import { isMacOS } from "../lib/desktop.js";
import { getNativeBrowserRuntime, type NativeBrowserRuntime } from "../lib/native-browser-runtime.js";
import { useConfirm } from "./ConfirmDialog.js";
import { FileViewer } from "./FileViewer.js";
import { fileType, formatFileSize } from "../lib/filetype.js";
import { useWorkbenchViewSession } from "../hooks/useWorkbenchViewSession.js";
import { useResizableWidth } from "../hooks/useResizableWidth.js";
import type {
  WorkbenchBrowserPage,
  WorkbenchBrowserTarget,
  WorkbenchNavigationResult,
  WorkbenchViewKind,
} from "../lib/workbench-view-session.js";
import {
  ChevronIcon,
  CommitIcon,
  CopyIcon,
  CheckIcon,
  ChatIcon,
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

const TAB_META: Record<WorkbenchViewKind, { label: string; icon: () => ReactNode }> = {
  diff: { label: "改动", icon: () => <FileIcon size={14} /> },
  files: { label: "文件", icon: () => <FolderIcon size={14} /> },
  browser: { label: "浏览器", icon: () => <GlobeIcon size={14} /> },
};
export type BrowserTarget = WorkbenchBrowserTarget;

const DOCK_WIDTH_KEY = "easywork.side-dock.width";
const DOCK_WIDTH_DEFAULT = 420;
const DOCK_WIDTH_MIN = 320;
const DOCK_WIDTH_MAX = 760;

function fileIconFor(p: string) {
  const ft = fileType(p);
  return <ft.Icon size={14} style={{ color: ft.color }} />;
}

function DockEmpty({ children }: { children: ReactNode }) {
  return <div className="rev-empty sd-empty">{children}</div>;
}

/**
 * 统一右侧「工作台坞」：对话区与工作区共用。
 * tab = 改动(git，按需) / 文件(工件+文件树) / 预览(网页)。
 * 合并了原 ArtifactsPanel、独立 WebPreview、WorkspacePanel 三套抽屉。
 */
export function SideDock({
  open,
  files,
  previewScope,
  previewId,
  onFilesRefresh,
  onRevealDir,
  filesEmpty,
  browserTarget,
  git,
  target,
  onNewTask,
  onOpenTerminal,
}: {
  open: boolean;
  files: WsEntry[];
  /** 统一文件预览的作用域 + id（FileViewer 据此走 /files/meta + /files/raw）。 */
  previewScope: "workspace" | "chat";
  previewId: string;
  onFilesRefresh: () => void;
  onRevealDir: () => void;
  filesEmpty: ReactNode;
  /** 消息链接触发的一次浏览器导航；nonce 使重复点击同一 URL 仍能重新激活。 */
  browserTarget: BrowserTarget | null;
  git?: GitContext;
  /** 外部请求查看某文件的改动（点「文件改动」卡）：跳到 改动(工作区)/文件(对话) 视图。 */
  target?: { path: string; nonce: number } | null;
  /** 空态入口：创建一个新的主任务。 */
  onNewTask: () => void;
  /** Desktop 空态入口：在对话区下方打开独立终端。 */
  onOpenTerminal?: () => void;
}) {
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [maxed, setMaxed] = useState(false);
  const {
    width: dockWidth,
    onResizeStart,
    resizeByKeyboard,
  } = useResizableWidth({
    storageKey: DOCK_WIDTH_KEY,
    min: DOCK_WIDTH_MIN,
    max: DOCK_WIDTH_MAX,
    defaultValue: DOCK_WIDTH_DEFAULT,
    dragDirection: -1,
  });
  const [toolbarHost, setToolbarHost] = useState<HTMLElement | null>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const repo = !!git?.status.repo;
  const nativeBrowserRuntime = useMemo(() => getNativeBrowserRuntime(), []);
  const {
    views: openViews,
    activeViewId,
    activeView,
    availableKinds,
    open: openView,
    activate: activateView,
    close: closeView,
    navigateBrowser,
    openFile,
    clearFileSelection,
    clearBrowser,
  } = useWorkbenchViewSession({
    files,
    previewScope,
    previewId,
    browserTarget,
    fileTarget: target,
    hasDiff: Boolean(git),
    routeFileTargetsToDiff: repo,
    nativeBrowserRuntime,
  });
  const mac = isMacOS();
  const terminalAvailable = Boolean(onOpenTerminal);

  useEffect(() => {
    setToolbarHost(document.getElementById("side-dock-titlebar-host"));
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--side-dock-width", `${dockWidth}px`);
    return () => {
      root.style.removeProperty("--side-dock-width");
    };
  }, [dockWidth]);

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

  useEffect(() => {
    if (!open || openViews.length > 0) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "t") {
        event.preventDefault();
        void openView("browser");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, openViews.length, openView]);


  const titlebarTabs = open && toolbarHost
    ? createPortal(
      <div className={`sd-titlebar-toolbar ${maxed ? "max" : ""}`} data-tauri-drag-region>
        <div className="sd-open-tabs" role="tablist" aria-label="已打开的工作台视图" data-tauri-drag-region>
          {openViews.map((tab) => (
            <div key={tab.id} className={`sd-tab-shell ${activeViewId === tab.id ? "on" : ""}`} data-tauri-drag-region>
              <button
                className={`sd-tab ${activeViewId === tab.id ? "on" : ""}`}
                data-testid={`side-dock-tab-${tab.id}`}
                role="tab"
                aria-selected={activeViewId === tab.id}
                onClick={() => activateView(tab.id)}
              >
                {TAB_META[tab.kind].icon()}
                <span>{tab.label}</span>
                {tab.kind === "files" && files.length > 0 && <span className="rev-count">{files.length}</span>}
              </button>
              <button
                type="button"
                className="sd-tab-close"
                title={`关闭${tab.label}标签`}
                aria-label={`关闭${tab.label}标签`}
                onClick={() => void closeView(tab.id)}
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
              {availableKinds.map((tab) => (
                <button
                  type="button"
                  key={tab}
                  role="menuitem"
                  onClick={() => {
                    setAddMenuOpen(false);
                    void openView(tab);
                  }}
                >
                  {TAB_META[tab].icon()}
                  <span>{TAB_META[tab].label}</span>
                  {openViews.some((candidate) => candidate.kind === tab) && <CheckIcon size={14} className="sd-menu-check" />}
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
  const resizeHandle = open && !maxed
    ? createPortal(
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
      />,
      document.body,
    )
    : null;

  return (
    <>
      {titlebarTabs}
      {resizeHandle}
      <aside
      className={`side-dock ${open ? "open" : ""} ${maxed ? "max" : ""}`}
      data-testid="side-dock"
      style={maxed ? undefined : { width: dockWidth }}
    >
      <div className="sd-body">
        {!activeView && (
          <div className="sd-launcher" data-testid="side-dock-empty">
            <button type="button" className="sd-launcher-action" onClick={onNewTask}>
              <ChatIcon size={17} />
              <span>新任务</span>
              <kbd>{mac ? "⌘N" : "Ctrl N"}</kbd>
            </button>
            <button type="button" className="sd-launcher-action" onClick={() => void openView("browser")}>
              <GlobeIcon size={17} />
              <span>浏览器</span>
              <kbd>{mac ? "⌘T" : "Ctrl T"}</kbd>
            </button>
            {terminalAvailable && (
              <button type="button" className="sd-launcher-action" onClick={onOpenTerminal}>
                <TerminalIcon size={17} />
                <span>终端</span>
              </button>
            )}
          </div>
        )}
        {activeView?.kind === "diff" && git && <DiffTab git={git} />}
        {activeView?.kind === "files" && (
          <FilesTab
            files={files}
            scope={previewScope}
            id={previewId}
            emptyHint={filesEmpty}
            selectedPath={activeView.selection?.path ?? null}
            maxed={maxed}
            onRefresh={onFilesRefresh}
            onRevealDir={onRevealDir}
            onOpenFile={openFile}
            onClearSelection={clearFileSelection}
          />
        )}
        {activeView?.kind === "browser" && (
          <PreviewTab
            page={activeView.page ?? null}
            onNavigate={navigateBrowser}
            onClear={() => void clearBrowser()}
            nativeRuntime={nativeBrowserRuntime}
            visible={open}
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
  selectedPath,
  maxed,
  onRefresh,
  onRevealDir,
  onOpenFile,
  onClearSelection,
}: {
  files: WsEntry[];
  scope: "workspace" | "chat";
  id: string;
  emptyHint: ReactNode;
  selectedPath: string | null;
  maxed: boolean;
  onRefresh: () => void;
  onRevealDir: () => void;
  onOpenFile: (path: string) => Promise<unknown>;
  onClearSelection: () => void;
}) {
  // 交付卡可能指向超过列表默认深度的文件；合成一条可预览项，点击不依赖 FilesTab 是否已列到它。
  const visibleFiles = useMemo(() => {
    if (!selectedPath || files.some((file) => file.path === selectedPath)) return files;
    return [{ path: selectedPath, type: "file" as const }, ...files];
  }, [files, selectedPath]);

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
            className={`af-file ${selectedPath === file.path ? "active" : ""}`}
            onClick={() => void onOpenFile(file.path)}
          >
            {fileIconFor(file.path)}
            <span className="af-path" title={file.path}>{file.path}</span>
            {file.size != null && <span className="af-size">{formatFileSize(file.size)}</span>}
          </button>
        ))}
      </div>
    </div>
  );
  const fileViewer = selectedPath ? (
    <FileViewer
      key={selectedPath}
      source={{ kind: "fs", scope, id, path: selectedPath }}
      onBack={maxed ? undefined : onClearSelection}
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
  return selectedPath ? <div className="files-detail">{fileViewer}</div> : fileList;
}

// ===== 浏览器 tab：Desktop URL → 原生子 WebView；Web URL / HTML 文件 → iframe =====
function PreviewTab({
  page,
  onNavigate,
  onClear,
  nativeRuntime,
  visible,
}: {
  page: WorkbenchBrowserPage | null;
  onNavigate: (url: string) => Promise<WorkbenchNavigationResult>;
  onClear: () => void;
  nativeRuntime: NativeBrowserRuntime;
  visible: boolean;
}) {
  const [nonce, setNonce] = useState(0);
  const [copied, setCopied] = useState(false);
  const [draft, setDraft] = useState(page?.kind === "url" ? page.url : page?.name ?? "");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(page?.kind === "url" ? page.url : page?.name ?? "");
    setError(null);
  }, [page]);

  const navigate = async () => {
    const result = await onNavigate(draft);
    if (result.status === "rejected") {
      setError("请输入有效的 http(s) 地址");
      return;
    }
    setError(null);
    if (result.destination === "browser" && result.url) setDraft(result.url);
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
              void navigate();
            }
          }}
        />
        <button className="fv-btn" title="前往" onClick={() => void navigate()} disabled={!draft.trim()}>
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
        nativeRuntime.available ? (
          <NativeBrowserSurface
            url={page.url}
            refreshNonce={nonce}
            runtime={nativeRuntime}
            visible={visible}
            onError={setError}
          />
        ) : (
          <iframe
            key={`${page.url}#${nonce}`}
            className="wpv-frame"
            src={page.url}
            title="网页预览"
            referrerPolicy="no-referrer"
            sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
          />
        )
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

function NativeBrowserSurface({
  url,
  refreshNonce,
  runtime,
  visible,
  onError,
}: {
  url: string;
  refreshNonce: number;
  runtime: NativeBrowserRuntime;
  visible: boolean;
  onError: (message: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const refreshRef = useRef(refreshNonce);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !visible) {
      void runtime.hide();
      return;
    }

    let frame = 0;
    let lastBounds = "";
    const sync = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = host.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) {
          lastBounds = "";
          void runtime.hide();
          return;
        }
        const bounds = {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
        const nextBounds = `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`;
        if (nextBounds === lastBounds) return;
        lastBounds = nextBounds;
        void runtime.show(url, bounds).catch((error: unknown) => {
          onError(`无法打开原生浏览器：${error instanceof Error ? error.message : String(error)}`);
        });
      });
    };

    const observer = new ResizeObserver(sync);
    observer.observe(host);
    window.addEventListener("resize", sync);
    sync();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", sync);
      void runtime.hide();
    };
  }, [onError, runtime, url, visible]);

  useEffect(() => {
    if (refreshRef.current === refreshNonce) return;
    refreshRef.current = refreshNonce;
    if (visible) void runtime.reload();
  }, [refreshNonce, runtime, visible]);

  return <div ref={hostRef} className="wpv-native-surface" data-testid="native-browser-surface" />;
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
