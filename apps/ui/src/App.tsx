import { useCallback, useEffect, useState } from "react";
import type { Project } from "@ew/shared";
import { currentConfig, getClient, initRuntimeConfig } from "./lib/client.js";
import { applyTheme, loadThemePrefs, saveThemePrefs, type ThemePrefs } from "./lib/prefs.js";
import { pickWorkspaceDir } from "./lib/desktop.js";
import { Chat } from "./pages/Chat.js";
import { Workspace } from "./pages/Workspace.js";
import { Models } from "./pages/Models.js";
import { Settings } from "./pages/Settings.js";
import { KnowledgeBase } from "./pages/KnowledgeBase.js";
import { Skills } from "./pages/Skills.js";
import { Mcp } from "./pages/Mcp.js";
import { Memory } from "./pages/Memory.js";
import { BoxIcon, BrainIcon, ChatIcon, FolderTreeIcon, FolderClosedIcon, GlobeIcon, KbIcon, NewChatIcon, PanelIcon, SlidersIcon, SparkIcon, TrashIcon, WrenchIcon } from "./icons.js";

type Tab = "chat" | "workspace" | "models" | "kb" | "skills" | "mcp" | "memory" | "settings";
type Status = "connecting" | "ok" | "unauthorized" | "unreachable";
interface ThreadItem {
  id: string;
  title: string;
  updatedAt: string;
  projectId?: string;
}

// 左下角 EasyWork 块的弹出菜单项（不含「聊天」——聊天经「新对话」/会话列表进入）
const MENU: { id: Tab; label: string; Icon: typeof ChatIcon }[] = [
  { id: "models", label: "模型", Icon: BoxIcon },
  { id: "kb", label: "知识库", Icon: KbIcon },
  { id: "skills", label: "Skills", Icon: SparkIcon },
  { id: "mcp", label: "MCP", Icon: WrenchIcon },
  { id: "memory", label: "记忆", Icon: BrainIcon },
  { id: "settings", label: "设置", Icon: SlidersIcon },
];

export function App() {
  const [tab, setTab] = useState<Tab>("chat");
  const [models, setModels] = useState<string[]>([]);
  const [status, setStatus] = useState<Status>("connecting");
  const [menuOpen, setMenuOpen] = useState(false);

  const [threadId, setThreadId] = useState<string>(() => crypto.randomUUID());
  const [threads, setThreads] = useState<ThreadItem[]>([]);
  const [contexts, setContexts] = useState<Record<string, number>>({});
  const [collapsed, setCollapsed] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemePrefs>(loadThemePrefs);

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
      // 侧栏「对话」仅列纯聊天会话；工作区会话（带 projectId）在各自工作区内管理。
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
    // 未选目录 → 后端在 ~/.easywork/workspace 下自动新建 NewProject{N}（名称/目录均由后端生成）。
    if (!dir && !confirm("未选择目录。在默认工作区下新建 NewProject？")) return;
    try {
      const p = dir
        ? await getClient().createProject({ name: dir.split(/[/\\]/).filter(Boolean).pop() || "工作区", workspaceDir: dir })
        : await getClient().createProject({});
      await refreshProjects();
      setProjectId(p.id);
      setTab("workspace");
    } catch (e) {
      alert(`创建工作区失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const delProject = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const p = projects.find((x) => x.id === id);
    const name = p?.name ?? "该工作区";
    const ok = confirm(
      `删除工作区「${name}」？\n\n` +
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
    setTab("chat");
  };
  const selectThread = (id: string) => {
    setThreadId(id);
    setTab("chat");
  };
  const selectProject = (id: string) => {
    setProjectId(id);
    setTab("workspace");
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

  return (
    <div className="app">
      <aside className={`sidebar ${collapsed ? "collapsed" : ""}`}>
        <div className="brand">
          <span className="logo">
            <SparkIcon size={17} />
          </span>
          <span className="name">
            Easy<b>Work</b>
          </span>
          <button className="collapse-btn" title={collapsed ? "展开侧栏" : "收起侧栏"} onClick={() => setCollapsed((v) => !v)}>
            <PanelIcon size={17} />
          </button>
        </div>

        <div className="side-actions">
          <button className="newbtn" onClick={newChat} title="新建对话">
            <NewChatIcon size={15} />
            <span>对话</span>
          </button>
          <button className="newbtn" onClick={() => void newWorkspace()} title="新建工作区（选择本地目录）">
            <FolderTreeIcon size={15} />
            <span>工作区</span>
          </button>
        </div>

        <div className="side-scroll">
          <div className="side-threads">
            <div className="side-label">工作区</div>
            <div className="threads-list">
              {projects.length === 0 && <div className="threads-empty">还没有工作区</div>}
              {projects.map((p) => (
                <div
                  key={p.id}
                  className={`thread-item ${tab === "workspace" && p.id === projectId ? "active" : ""}`}
                  onClick={() => selectProject(p.id)}
                  title={p.workspaceDir}
                >
                  <FolderClosedIcon size={14} />
                  <span>{p.name}</span>
                  <button className="thread-del" title="删除" onClick={(e) => void delProject(p.id, e)}>
                    <TrashIcon size={13} />
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="side-threads">
            <div className="side-label">对话</div>
            <div className="threads-list">
              {threads.length === 0 && <div className="threads-empty">还没有会话</div>}
              {threads.map((t) => (
                <div
                  key={t.id}
                  className={`thread-item ${tab === "chat" && t.id === threadId ? "active" : ""}`}
                  onClick={() => selectThread(t.id)}
                  title={t.title}
                >
                  <ChatIcon size={14} />
                  <span>{t.title || "新会话"}</span>
                  <button className="thread-del" title="删除" onClick={(e) => void delThread(t.id, e)}>
                    <TrashIcon size={13} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="side-foot">
          {menuOpen && (
            <>
              <div className="menu-backdrop" onClick={() => setMenuOpen(false)} />
              <div className="profile-menu" role="menu">
                {MENU.map(({ id, label, Icon }) => (
                  <button
                    key={id}
                    className={tab === id ? "active" : ""}
                    role="menuitem"
                    onClick={() => {
                      setTab(id);
                      setMenuOpen(false);
                    }}
                  >
                    <Icon size={16} />
                    <span>{label}</span>
                  </button>
                ))}
              </div>
            </>
          )}
          <button
            className={`profile ${status} ${menuOpen ? "open" : ""}`}
            onClick={() => setMenuOpen((v) => !v)}
            title={statusText}
          >
            <span className="avatar">
              <GlobeIcon size={15} />
            </span>
            <span className="pinfo">
              <b>
                <span className={`dot ${status === "ok" ? "ok" : status === "connecting" ? "" : "err"}`} />
                {statusText}
              </b>
            </span>
          </button>
        </div>
      </aside>

      <main className="content">
        {tab === "chat" && (
          <Chat key={threadId} models={models} contexts={contexts} threadId={threadId} onSaved={refreshThreads} />
        )}
        {tab === "workspace" &&
          (() => {
            const project = projects.find((p) => p.id === projectId);
            return project ? (
              <Workspace key={project.id} project={project} models={models} onChanged={refreshProjects} />
            ) : (
              <div className="empty">
                <div className="ring">
                  <FolderTreeIcon size={28} />
                </div>
                <h2>工作区</h2>
                <p>在本地项目目录里让 AI 读写文件、运行命令完成编码任务。点击左侧「新建工作区」选择目录开始。</p>
              </div>
            );
          })()}
        {tab === "models" && <Models onChange={check} />}
        {tab === "kb" && <KnowledgeBase />}
        {tab === "skills" && <Skills />}
        {tab === "mcp" && <Mcp />}
        {tab === "memory" && <Memory />}
        {tab === "settings" && <Settings onChange={check} theme={theme} onThemeChange={changeTheme} />}
      </main>
    </div>
  );
}
