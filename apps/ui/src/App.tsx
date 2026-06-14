import { useCallback, useEffect, useState } from "react";
import { currentConfig, getClient, initRuntimeConfig } from "./lib/client.js";
import { Chat } from "./pages/Chat.js";
import { Models } from "./pages/Models.js";
import { Settings } from "./pages/Settings.js";
import { KnowledgeBase } from "./pages/KnowledgeBase.js";
import { Skills } from "./pages/Skills.js";
import { Mcp } from "./pages/Mcp.js";
import { Memory } from "./pages/Memory.js";
import { BoxIcon, BrainIcon, ChatIcon, KbIcon, NewChatIcon, PanelIcon, SlidersIcon, SparkIcon, TrashIcon, WrenchIcon } from "./icons.js";

type Tab = "chat" | "models" | "kb" | "skills" | "mcp" | "memory" | "settings";
type Status = "connecting" | "ok" | "unauthorized" | "unreachable";
interface ThreadItem {
  id: string;
  title: string;
  updatedAt: string;
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

  const refreshThreads = useCallback(async () => {
    try {
      setThreads(await getClient().listThreads());
    } catch {
      /* ignore */
    }
  }, []);

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
    } catch {
      setStatus("unauthorized");
    }
  }, [refreshThreads]);

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
  const delThread = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
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

        <button className="newchat" onClick={newChat} title="新对话">
          <NewChatIcon size={16} />
          <span>新对话</span>
        </button>

        {tab === "chat" && (
          <div className="side-threads">
            <div className="side-label">最近</div>
            <div className="threads-list">
              {threads.length === 0 && <div className="threads-empty">还没有会话</div>}
              {threads.map((t) => (
                <div
                  key={t.id}
                  className={`thread-item ${t.id === threadId ? "active" : ""}`}
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
        )}

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
            title="EasyWork"
          >
            <span className="avatar">
              <SparkIcon size={15} />
            </span>
            <span className="pinfo">
              <b>EasyWork</b>
              <small>
                <span className={`dot ${status === "ok" ? "ok" : status === "connecting" ? "" : "err"}`} />
                {statusText}
              </small>
            </span>
          </button>
        </div>
      </aside>

      <main className="content">
        {tab === "chat" && (
          <Chat models={models} contexts={contexts} threadId={threadId} onSaved={refreshThreads} />
        )}
        {tab === "models" && <Models onChange={check} />}
        {tab === "kb" && <KnowledgeBase />}
        {tab === "skills" && <Skills />}
        {tab === "mcp" && <Mcp />}
        {tab === "memory" && <Memory />}
        {tab === "settings" && <Settings onChange={check} />}
      </main>
    </div>
  );
}
