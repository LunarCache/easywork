import { useCallback, useEffect, useState } from "react";
import type { Project } from "@ew/shared";
import { currentConfig, getClient, initRuntimeConfig } from "./lib/client.js";
import { applyTheme, loadThemePrefs, saveThemePrefs, type ThemePrefs } from "./lib/prefs.js";
import { pickWorkspaceDir, isDesktop } from "./lib/desktop.js";
import { Chat } from "./pages/Chat.js";
import { Workspace } from "./pages/Workspace.js";
import { FilesPage } from "./pages/FilesPage.js";
import { Titlebar } from "./components/Titlebar.js";
import { Sidebar, type Mode } from "./components/Sidebar.js";
import { Settings } from "./pages/Settings.js";
import { FolderTreeIcon, InboxIcon } from "./icons.js";

type Status = "connecting" | "ok" | "unauthorized" | "unreachable";
type Overlay = "settings" | null;
interface ThreadItem {
  id: string;
  title: string;
  updatedAt: string;
  projectId?: string;
}

const SESSION_W_KEY = "ew.sessionWidth";
const loadSessionWidth = (): number => {
  const n = Number(localStorage.getItem(SESSION_W_KEY));
  return Number.isFinite(n) && n >= 200 && n <= 460 ? n : 272;
};

export function App() {
  const [mode, setMode] = useState<Mode>("chat");
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [models, setModels] = useState<string[]>([]);
  const [status, setStatus] = useState<Status>("connecting");

  const [threadId, setThreadId] = useState<string>(() => crypto.randomUUID());
  const [threads, setThreads] = useState<ThreadItem[]>([]);
  const [contexts, setContexts] = useState<Record<string, number>>({});
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [workThreadId, setWorkThreadId] = useState<string>("");
  const [theme, setTheme] = useState<ThemePrefs>(loadThemePrefs);
  const [sessionWidth, setSessionWidth] = useState<number>(loadSessionWidth);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [dockOpen, setDockOpen] = useState(false);
  const [workBranch, setWorkBranch] = useState<string | undefined>(undefined);
  // 点项目「查看文件」→ 主区切到该项目的文件浏览页（替代对话，左上角「返回任务」回退）。
  const [filesProjectId, setFilesProjectId] = useState<string | null>(null);

  // 外观：应用到 <html>；跟随系统时监听 OS 明暗变化实时切换。
  useEffect(() => {
    applyTheme(theme);
    if (theme.appearance !== "system" || typeof matchMedia !== "function") return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme(theme);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  // 切换模式 / 会话 / 工作区时收起工作台面板（dockOpen 是 App 级共享态，避免跨会话「带着」开着的面板）+ 清空分支（由新 Workspace 重新上报）。
  useEffect(() => {
    setDockOpen(false);
    setWorkBranch(undefined);
  }, [mode, threadId, workThreadId, projectId]);

  const changeTheme = useCallback((next: ThemePrefs) => {
    setTheme(next);
    saveThemePrefs(next);
  }, []);

  // 全量会话（含工作区会话，带 projectId）；对话/工作区列表各自从中筛选/分组。
  const refreshThreads = useCallback(async () => {
    try {
      setThreads(await getClient().listThreads());
    } catch {
      /* ignore */
    }
  }, []);

  const refreshProjects = useCallback(async () => {
    try {
      const ps = await getClient().listProjects();
      setProjects(ps);
      setProjectId((cur) => cur ?? ps[0]?.id ?? null);
    } catch {
      /* ignore */
    }
  }, []);

  const newWorkspace = async () => {
    const dir = await pickWorkspaceDir();
    if (!dir && !confirm("未选择目录。在默认工作区下新建 NewProject？")) return;
    try {
      const p = dir
        ? await getClient().createProject({ name: dir.split(/[/\\]/).filter(Boolean).pop() || "工作区", workspaceDir: dir })
        : await getClient().createProject({});
      await refreshProjects();
      setProjectId(p.id);
      setMode("work");
    } catch (e) {
      alert(`创建工作区失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const delProject = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const p = projects.find((x) => x.id === id);
    const ok = confirm(
      `删除工作区「${p?.name ?? "该工作区"}」？\n\n` +
        `仅删除本软件内的会话历史（含其下全部对话及由其抽取的记忆事实），不会删除工作区目录中的任何文件：\n` +
        `${p?.workspaceDir ?? ""}`,
    );
    if (!ok) return;
    await getClient().deleteProject(id);
    setProjectId((cur) => (cur === id ? null : cur));
    void refreshProjects();
  };

  const check = useCallback(async () => {
    await initRuntimeConfig();
    const c = currentConfig();
    setStatus("connecting");
    try {
      const h = await fetch(`${c.baseUrl}/health`);
      if (!h.ok) throw new Error(`health HTTP ${h.status}`);
    } catch {
      setStatus("unreachable");
      return;
    }
    try {
      const info = await getClient().listModels();
      setModels(info.routed);
      setContexts(info.context ?? {});
      setStatus("ok");
      void refreshThreads();
      void refreshProjects();
    } catch {
      setStatus("unauthorized");
    }
  }, [refreshThreads, refreshProjects]);

  useEffect(() => {
    void check();
  }, [check]);

  const newChat = () => {
    setFilesProjectId(null);
    setThreadId(crypto.randomUUID());
    setMode("chat");
  };
  // ⌘N / Ctrl-N：新建对话（侧栏标注的快捷键）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        newChat();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // newChat 仅调用稳定的 setState，无需进依赖。
  }, []);
  const selectThread = (id: string) => {
    setFilesProjectId(null);
    setThreadId(id);
    setMode("chat");
  };
  // 某工作区的最近会话 id（threads 按 updatedAt desc）；无则用默认 ws-<id> 线程。
  const latestWorkThread = (pid: string) => threads.find((t) => t.projectId === pid)?.id ?? `ws-${pid}`;
  const selectProject = async (id: string) => {
    setFilesProjectId(null);
    setProjectId(id);
    setMode("work");
    let tid = latestWorkThread(id);
    // 首屏 threads 尚未加载时 latestWorkThread 退化为合成 id（侧栏不高亮 + 不续接最近会话）；
    // 此时补拉一次会话列表再定位该项目最近会话。
    if (tid === `ws-${id}` && threads.length === 0) {
      try {
        const ts = await getClient().listThreads();
        setThreads(ts);
        tid = ts.find((t) => t.projectId === id)?.id ?? tid;
      } catch {
        /* ignore：用合成默认线程 */
      }
    }
    setWorkThreadId(tid);
  };
  const selectWorkThread = (pid: string, tid: string) => {
    setFilesProjectId(null);
    setProjectId(pid);
    setWorkThreadId(tid);
    setMode("work");
  };
  const newWorkThread = (pid: string) => {
    setFilesProjectId(null);
    setProjectId(pid);
    setWorkThreadId(`ws-${pid}-${crypto.randomUUID().slice(0, 8)}`);
    setMode("work");
  };
  // 点项目「查看文件」：切到该项目（work 模式）并把主区切到文件浏览页。
  const openProjectFiles = (pid: string) => {
    setProjectId(pid);
    setWorkThreadId((cur) => cur || latestWorkThread(pid));
    setFilesProjectId(pid);
    setMode("work");
  };
  // 切换顶部模式（对话/工作区/收件箱）时退出文件浏览页。
  const changeMode = (m: Mode) => {
    setFilesProjectId(null);
    setMode(m);
  };
  const delThread = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const t = threads.find((x) => x.id === id);
    if (!confirm(`删除对话「${t?.title || "新会话"}」？此操作不可撤销（删除会话记录及由其抽取的记忆事实）。`)) return;
    await getClient().deleteThread(id);
    if (id === threadId) newChat();
    if (id === workThreadId) {
      // 删除当前工作区会话 → 切到该项目下一个剩余会话（无则用合成默认线程）。
      const next = threads.find((t) => t.projectId === projectId && t.id !== id)?.id ?? `ws-${projectId ?? ""}`;
      setWorkThreadId(next);
    }
    void refreshThreads();
  };

  const statusText =
    status === "ok" ? "已连接" : status === "connecting" ? "连接中…" : status === "unauthorized" ? "未授权" : "未连接";

  // 会话列表宽度拖拽（持久化）。
  const onResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sessionWidth;
    let w = startW;
    const move = (ev: MouseEvent) => {
      w = Math.min(460, Math.max(200, startW + ev.clientX - startX));
      setSessionWidth(w);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      try {
        localStorage.setItem(SESSION_W_KEY, String(w));
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const project = projects.find((p) => p.id === projectId);
  // 工作台面板仅在「对话」或「有项目且不在文件浏览页」的工作区会话里可用（空态/文件页无 dock，开关无意义）。
  const inWorkChat = mode === "work" && !!project && filesProjectId !== project.id;
  const activeId = mode === "work" ? workThreadId : threadId;
  const activeTitle = threads.find((t) => t.id === activeId)?.title?.trim();
  const taskTitle =
    mode === "inbox"
      ? "收件箱"
      : activeTitle || (mode === "work" ? project?.name ?? "新任务" : "新任务");

  return (
    <div className={`ad-app ${isDesktop() ? "is-desktop" : ""} ${sidebarOpen ? "" : "side-collapsed"}`}>
      <Titlebar
        sidebarOpen={sidebarOpen}
        sidebarWidth={sessionWidth}
        onToggleSidebar={() => setSidebarOpen((o) => !o)}
        taskTitle={taskTitle}
        isDesktop={isDesktop()}
        showDock={overlay !== "settings" && (mode === "chat" || inWorkChat)}
        dockOpen={dockOpen}
        onToggleDock={() => setDockOpen((v) => !v)}
        {...(mode === "work" && project ? { projectName: project.name } : {})}
        {...(mode === "work" && workBranch ? { branch: workBranch } : {})}
      />
      {/* ad-body 始终挂载（设置打开时 CSS 隐藏而非卸载）——否则会卸载 Chat/Workspace 并中断在途的流式运行。 */}
      <div className={`ad-body ${overlay === "settings" ? "ad-hidden" : ""}`}>
        {sidebarOpen && (
          <>
            <div className="ad-sessions-wrap" style={{ width: sessionWidth }}>
              <Sidebar
                threads={threads}
                projects={projects}
                mode={mode}
                threadId={threadId}
                projectId={projectId}
                workThreadId={workThreadId}
                status={status}
                statusText={statusText}
                onNewChat={newChat}
                onNewWorkspace={() => void newWorkspace()}
                onSelectThread={selectThread}
                onSelectProject={(id) => void selectProject(id)}
                onSelectWorkThread={selectWorkThread}
                onNewWorkThread={newWorkThread}
                onDelThread={(id, e) => void delThread(id, e)}
                onDelProject={(id, e) => void delProject(id, e)}
                onOpenFiles={openProjectFiles}
                onOpenInbox={() => changeMode("inbox")}
                onOpenSettings={() => setOverlay("settings")}
              />
            </div>
            <div className="ad-resizer" title="拖动调整宽度" onMouseDown={onResizeStart}>
              <span />
            </div>
          </>
        )}

        <main className="ad-main">
          {mode === "chat" && (
            <Chat
              key={threadId}
              models={models}
              contexts={contexts}
              threadId={threadId}
              onSaved={refreshThreads}
              dockOpen={dockOpen}
              setDockOpen={setDockOpen}
            />
          )}
          {mode === "work" &&
            (project && filesProjectId === project.id ? (
              <FilesPage key={`files-${project.id}`} project={project} onBack={() => setFilesProjectId(null)} />
            ) : project ? (
              <Workspace
                key={project.id}
                project={project}
                models={models}
                threadId={workThreadId || latestWorkThread(project.id)}
                onChanged={refreshProjects}
                onThreadsChanged={refreshThreads}
                onBranchChange={setWorkBranch}
                dockOpen={dockOpen}
                setDockOpen={setDockOpen}
              />
            ) : (
              <div className="empty">
                <div className="ring">
                  <FolderTreeIcon size={28} />
                </div>
                <h2>工作区</h2>
                <p>在本地项目目录里让 AI 读写文件、运行命令完成编码任务。点击「新建工作区」选择目录开始。</p>
              </div>
            ))}
          {mode === "inbox" && (
            <div className="empty">
              <div className="ring">
                <InboxIcon size={28} />
              </div>
              <h2>收件箱</h2>
              <p>连接 Telegram / 企业微信 / 飞书等 IM 渠道后，外部对话会汇入这里，由同一个大脑处理。</p>
            </div>
          )}
        </main>
      </div>
      {overlay === "settings" && (
        <Settings theme={theme} onThemeChange={changeTheme} onModelsChange={check} onBack={() => setOverlay(null)} />
      )}
    </div>
  );
}
