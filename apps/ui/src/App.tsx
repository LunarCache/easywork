import { useCallback, useEffect, useState } from "react";
import type { Project } from "@ew/shared";
import { currentConfig, getClient, initRuntimeConfig } from "./lib/client.js";
import { applyTheme, loadThemePrefs, saveThemePrefs, type ThemePrefs } from "./lib/prefs.js";
import { pickWorkspaceDir } from "./lib/desktop.js";
import { Chat } from "./pages/Chat.js";
import { Workspace } from "./pages/Workspace.js";
import { Titlebar } from "./components/Titlebar.js";
import { IconRail, type Mode } from "./components/IconRail.js";
import { SessionList } from "./components/SessionList.js";
import { SettingsOverlay, type SettingsTab } from "./components/SettingsOverlay.js";
import { MemoryOverlay } from "./components/MemoryOverlay.js";
import { FolderTreeIcon, InboxIcon } from "./icons.js";

type Status = "connecting" | "ok" | "unauthorized" | "unreachable";
type Overlay = null | "settings" | "memory";
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
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("models");
  const [models, setModels] = useState<string[]>([]);
  const [status, setStatus] = useState<Status>("connecting");

  const [threadId, setThreadId] = useState<string>(() => crypto.randomUUID());
  const [threads, setThreads] = useState<ThreadItem[]>([]);
  const [contexts, setContexts] = useState<Record<string, number>>({});
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemePrefs>(loadThemePrefs);
  const [sessionWidth, setSessionWidth] = useState<number>(loadSessionWidth);

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

  const refreshThreads = useCallback(async () => {
    try {
      // 对话模式只列纯聊天会话（无 projectId）；工作区会话在各自工作区内管理。
      setThreads((await getClient().listThreads()).filter((t) => !t.projectId));
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
    setThreadId(crypto.randomUUID());
    setMode("chat");
  };
  const selectThread = (id: string) => {
    setThreadId(id);
    setMode("chat");
  };
  const selectProject = (id: string) => {
    setProjectId(id);
    setMode("work");
  };
  const delThread = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const t = threads.find((x) => x.id === id);
    if (!confirm(`删除对话「${t?.title || "新会话"}」？此操作不可撤销（删除会话记录及由其抽取的记忆事实）。`)) return;
    await getClient().deleteThread(id);
    if (id === threadId) newChat();
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
          setMode={setMode}
          onMemory={() => setOverlay("memory")}
          onSettings={() => setOverlay("settings")}
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
            onNewChat={newChat}
            onNewWorkspace={() => void newWorkspace()}
            onSelectThread={selectThread}
            onSelectProject={selectProject}
            onDelThread={(id, e) => void delThread(id, e)}
            onDelProject={(id, e) => void delProject(id, e)}
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
            (project ? (
              <Workspace key={project.id} project={project} models={models} onChanged={refreshProjects} />
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
        <SettingsOverlay
          tab={settingsTab}
          setTab={setSettingsTab}
          onClose={() => setOverlay(null)}
          onModelsChange={check}
          theme={theme}
          onThemeChange={changeTheme}
        />
      )}
      {overlay === "memory" && <MemoryOverlay onClose={() => setOverlay(null)} />}
    </div>
  );
}
