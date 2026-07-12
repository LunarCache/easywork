import { useCallback, useEffect, useRef, useState } from "react";
import type { ChannelKind, Project, Skill } from "@ew/shared";
import type { ModelSourceInfo } from "@ew/sdk";
import { currentConfig, getClient, initRuntimeConfig } from "./lib/client.js";
import { applyTheme, loadThemePrefs, saveThemePrefs, type ThemePrefs } from "./lib/prefs.js";
import { pickWorkspaceDir, isDesktop } from "./lib/desktop.js";
import { Chat } from "./pages/Chat.js";
import { Workspace } from "./pages/Workspace.js";
import { FilesPage } from "./pages/FilesPage.js";
import { Titlebar } from "./components/Titlebar.js";
import { Sidebar, type Mode } from "./components/Sidebar.js";
import { SearchPalette } from "./components/SearchPalette.js";
import { useConfirm } from "./components/ConfirmDialog.js";
import { SettingsPageHost as Settings, useSettingsPageHost } from "./settings/SettingsHost.js";
import { Inbox } from "./pages/Inbox.js";
import { FolderTreeIcon, PlusIcon } from "./icons.js";

type Status = "connecting" | "ok" | "unauthorized" | "unreachable";
interface ThreadItem {
  id: string;
  title: string;
  updatedAt: string;
  projectId?: string;
  channel?: { kind: ChannelKind; channelId: string };
}

const SESSION_W_KEY = "ew.sessionWidth";

const loadSessionWidth = (): number => {
  const n = Number(localStorage.getItem(SESSION_W_KEY));
  return Number.isFinite(n) && n >= 208 && n <= 420 ? n : 248;
};

export function App() {
  const { confirm: askConfirm, alert: showAlert, dialog: confirmDialog } = useConfirm();
  const settingsHost = useSettingsPageHost();
  const [mode, setMode] = useState<Mode>("chat");
  const [models, setModels] = useState<string[]>([]);
  const [modelSources, setModelSources] = useState<ModelSourceInfo[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
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
  const [searchOpen, setSearchOpen] = useState(false);
  const [dockOpen, setDockOpen] = useState(false);
  const [workBranch, setWorkBranch] = useState<string | undefined>(undefined);
  const workspaceCreatePending = useRef(false);
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

  const enterWorkspace = useCallback(async (workspaceDir?: string) => {
    if (workspaceCreatePending.current) return;
    workspaceCreatePending.current = true;
    try {
      const p = workspaceDir
        ? await getClient().createProject({
            name: workspaceDir.split(/[/\\]/).filter(Boolean).pop() || "工作区",
            workspaceDir,
          })
        : await getClient().createProject({});
      await refreshProjects();
      setFilesProjectId(null);
      setProjectId(p.id);
      setWorkThreadId(`ws-${p.id}`);
      setMode("work");
    } catch (e) {
      await showAlert({
        title: "创建工作区失败",
        body: e instanceof Error ? e.message : String(e),
      });
    } finally {
      workspaceCreatePending.current = false;
    }
  }, [refreshProjects, showAlert]);

  // 首页 / 侧栏的「新建工作区」直接进入默认工作区，不先打断用户要求选择目录。
  const newWorkspace = useCallback(async () => {
    await enterWorkspace();
  }, [enterWorkspace]);

  // 只有工作区上下文菜单里的「打开文件夹」才显式选择本地目录；取消后保持当前工作区。
  const openWorkspaceFolder = useCallback(async () => {
    const dir = await pickWorkspaceDir();
    if (!dir) return;
    await enterWorkspace(dir);
  }, [enterWorkspace]);

  const delProject = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const p = projects.find((x) => x.id === id);
    const ok = await askConfirm({
      title: `删除工作区「${p?.name ?? "该工作区"}」？`,
      body:
        `仅删除本软件内的会话历史（含其下全部对话及由其抽取的记忆事实），不会删除工作区目录中的任何文件。\n\n` +
        `工作区目录：\n${p?.workspaceDir ?? "默认工作区"}`,
      danger: true,
    });
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
      const [info, skillsInfo] = await Promise.all([
        getClient().listModels(),
        getClient().skillsInfo().catch(() => null),
      ]);
      setModels(info.routed);
      setModelSources(info.modelSources ?? []);
      setContexts(info.context ?? {});
      if (skillsInfo) setSkills(skillsInfo.skills);
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

  useEffect(() => {
    const createWorkspace = () => {
      void newWorkspace();
    };
    window.addEventListener("ew:new-workspace", createWorkspace as EventListener);
    return () => {
      window.removeEventListener("ew:new-workspace", createWorkspace as EventListener);
    };
  }, [newWorkspace]);

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
      } else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((o) => !o);
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
  const openChannelSettings = () => {
    settingsHost.openSection("channels");
  };
  // 切换顶部模式（对话/工作区/收件箱）时退出文件浏览页。
  const changeMode = (m: Mode) => {
    setFilesProjectId(null);
    setMode(m);
  };
  const delThread = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const t = threads.find((x) => x.id === id);
    let artifactCount = 0;
    if (!t?.projectId) {
      try {
        const entries = await getClient().chatFiles(id);
        artifactCount = entries.filter((entry) => entry.type === "file").length;
      } catch {
        /* 工件检查失败不阻断删除确认。 */
      }
    }
    const body = [
      "此操作不可撤销，会同时删除会话记录以及由该对话抽取出的记忆事实。",
      artifactCount > 0
        ? `检测到该对话产出了 ${artifactCount} 个文件；删除后这些对话工件也会从本机移除。`
        : "",
    ].filter(Boolean).join("\n\n");
    if (
      !(await askConfirm({
        title: `删除对话「${t?.title || "新会话"}」？`,
        body,
        danger: true,
      }))
    )
      return;
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
        showDock={!settingsHost.isOpen && (mode === "chat" || inWorkChat)}
        dockOpen={dockOpen}
        onToggleDock={() => setDockOpen((v) => !v)}
        {...(mode === "work" && project ? { projectName: project.name } : {})}
        {...(mode === "work" && workBranch ? { branch: workBranch } : {})}
      />
      {/* ad-body 始终挂载（设置打开时 CSS 隐藏而非卸载）——否则会卸载 Chat/Workspace 并中断在途的流式运行。 */}
      <div className={`ad-body ${settingsHost.isOpen ? "ad-hidden" : ""}`}>
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
                onOpenSettings={() => settingsHost.open()}
                onOpenSearch={() => setSearchOpen(true)}
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
              modelSources={modelSources}
              skills={skills}
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
                projects={projects}
                models={models}
                modelSources={modelSources}
                skills={skills}
                contexts={contexts}
                threadId={workThreadId || latestWorkThread(project.id)}
                onChanged={refreshProjects}
                onThreadsChanged={refreshThreads}
                onBranchChange={setWorkBranch}
                onSelectProject={(id) => void selectProject(id)}
                onOpenFolder={() => void openWorkspaceFolder()}
                dockOpen={dockOpen}
                setDockOpen={setDockOpen}
              />
            ) : (
              <div className="app-empty">
                <div className="app-empty-mark">
                  <FolderTreeIcon size={28} />
                </div>
                <h2>还没有工作区</h2>
                <p>先创建一个默认工作区即可开始；之后可从项目菜单按需打开本地文件夹。</p>
                <button className="set-btn primary" onClick={() => void newWorkspace()}>
                  <PlusIcon size={15} /> 新建工作区
                </button>
              </div>
            ))}
          {mode === "inbox" && (
            <Inbox onThreadsChanged={refreshThreads} onOpenChannelSettings={openChannelSettings} />
          )}
        </main>
      </div>
      {settingsHost.isOpen && (
        <Settings
          theme={theme}
          navWidth={sessionWidth}
          section={settingsHost.section}
          onSectionChange={settingsHost.openSection}
          onThemeChange={changeTheme}
          onModelsChange={check}
          onBack={settingsHost.close}
        />
      )}
      {searchOpen && (
        <SearchPalette
          threads={threads}
          projects={projects}
          onSelectThread={selectThread}
          onSelectWorkThread={selectWorkThread}
          onSelectProject={(id) => void selectProject(id)}
          onClose={() => setSearchOpen(false)}
        />
      )}
      {confirmDialog}
    </div>
  );
}
