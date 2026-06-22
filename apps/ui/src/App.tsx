import { useCallback, useEffect, useState } from "react";
import type { Project } from "@ew/shared";
import { currentConfig, getClient, initRuntimeConfig } from "./lib/client.js";
import { applyTheme, loadThemePrefs, saveThemePrefs, type ThemePrefs } from "./lib/prefs.js";
import { pickWorkspaceDir } from "./lib/desktop.js";
import { Chat } from "./pages/Chat.js";
import { Workspace } from "./pages/Workspace.js";
import { FilesPage } from "./pages/FilesPage.js";
import { Titlebar } from "./components/Titlebar.js";
import { IconRail, type Mode, type Tool } from "./components/IconRail.js";
import { SessionList } from "./components/SessionList.js";
import { PageOverlay } from "./components/PageOverlay.js";
import { KnowledgeBaseOverlay } from "./components/KnowledgeBaseOverlay.js";
import { MemoryOverlay } from "./components/MemoryOverlay.js";
import { Models } from "./pages/Models.js";
import { Skills } from "./pages/Skills.js";
import { Mcp } from "./pages/Mcp.js";
import { Settings } from "./pages/Settings.js";
import { FolderTreeIcon, InboxIcon } from "./icons.js";

type Status = "connecting" | "ok" | "unauthorized" | "unreachable";
type Overlay = null | Tool | "settings";
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
  // 点项目「查看文件」→ 主区切到该项目的文件浏览页（替代对话，左上角「返回任务」回退）。
  const [filesProjectId, setFilesProjectId] = useState<string | null>(null);

  // 外观：应用到 <html>；系统模式下跟随系统明暗变化。
  useEffect(() => {
    applyTheme(theme);
    if (theme.appearance !== "system" || typeof matchMedia !== "function") return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme(theme);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

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
  const selectThread = (id: string) => {
    setFilesProjectId(null);
    setThreadId(id);
    setMode("chat");
  };
  // 某工作区的最近会话 id（threads 按 updatedAt desc）；无则用默认 ws-<id> 线程。
  const latestWorkThread = (pid: string) => threads.find((t) => t.projectId === pid)?.id ?? `ws-${pid}`;
  const selectProject = (id: string) => {
    setFilesProjectId(null);
    setProjectId(id);
    setWorkThreadId(latestWorkThread(id));
    setMode("work");
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
    if (id === workThreadId) setWorkThreadId(`ws-${projectId ?? ""}`);
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

  return (
    <div className="ad-app">
      <Titlebar
        theme={theme}
        onThemeChange={changeTheme}
        onOpenSettings={() => setOverlay("settings")}
        {...(mode === "work" && project ? { branch: project.name } : {})}
      />
      <div className="ad-body">
        <IconRail
          mode={mode}
          setMode={changeMode}
          onOpen={(t) => setOverlay(t)}
          status={status}
          statusText={statusText}
        />
        <div className="ad-sessions-wrap" style={{ width: sessionWidth }}>
          <SessionList
            mode={mode}
            threads={threads}
            projects={projects}
            threadId={threadId}
            projectId={projectId}
            workThreadId={workThreadId}
            onNewChat={newChat}
            onNewWorkspace={() => void newWorkspace()}
            onSelectThread={selectThread}
            onSelectProject={selectProject}
            onSelectWorkThread={selectWorkThread}
            onNewWorkThread={newWorkThread}
            onDelThread={(id, e) => void delThread(id, e)}
            onDelProject={(id, e) => void delProject(id, e)}
            onOpenFiles={openProjectFiles}
          />
        </div>
        <div className="ad-resizer" title="拖动调整宽度" onMouseDown={onResizeStart}>
          <span />
        </div>

        <main className="ad-main">
          {mode === "chat" && (
            <Chat key={threadId} models={models} contexts={contexts} threadId={threadId} onSaved={refreshThreads} />
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

      {overlay === "models" && (
        <PageOverlay title="模型" onClose={() => setOverlay(null)}>
          <Models onChange={check} />
        </PageOverlay>
      )}
      {overlay === "kb" && <KnowledgeBaseOverlay onClose={() => setOverlay(null)} />}
      {overlay === "skills" && (
        <PageOverlay title="Skills" onClose={() => setOverlay(null)}>
          <Skills />
        </PageOverlay>
      )}
      {overlay === "mcp" && (
        <PageOverlay title="MCP" onClose={() => setOverlay(null)}>
          <Mcp />
        </PageOverlay>
      )}
      {overlay === "memory" && <MemoryOverlay onClose={() => setOverlay(null)} />}
      {overlay === "settings" && (
        <PageOverlay title="设置" onClose={() => setOverlay(null)}>
          <Settings theme={theme} onThemeChange={changeTheme} />
        </PageOverlay>
      )}
    </div>
  );
}
