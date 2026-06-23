import { useState } from "react";
import type { Project } from "@ew/shared";
import {
  PlusIcon,
  NewChatIcon,
  FolderTreeIcon,
  FolderClosedIcon,
  ChevronIcon,
  TrashIcon,
  GearIcon,
  PluginsIcon,
  InboxIcon,
} from "../icons.js";

export type Mode = "chat" | "work" | "inbox" | "plugins";
type Status = "connecting" | "ok" | "unauthorized" | "unreachable";

interface ThreadItem {
  id: string;
  title: string;
  updatedAt: string;
  projectId?: string;
}

/** updatedAt → 紧凑相对时间（mono）。 */
function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/**
 * 展开式侧栏（参考设计）：顶部快捷操作（新对话 / 打开工作区 / 收件箱 / 插件）+
 * 分区列表「项目」（工作区折叠组）与「对话」（独立聊天线程）+ 底部「设置」。
 * 「插件」直接打开主区的插件页（顶部标签切 模型/知识库/Skills/MCP/记忆），不再用下拉。
 */
export function Sidebar({
  threads,
  projects,
  mode,
  threadId,
  projectId,
  workThreadId,
  status,
  statusText,
  onNewChat,
  onNewWorkspace,
  onSelectThread,
  onSelectProject,
  onSelectWorkThread,
  onNewWorkThread,
  onDelThread,
  onDelProject,
  onOpenFiles,
  onOpenPlugins,
  onOpenInbox,
  onOpenSettings,
}: {
  threads: ThreadItem[];
  projects: Project[];
  mode: Mode;
  threadId: string;
  projectId: string | null;
  workThreadId: string;
  status: Status;
  statusText: string;
  onNewChat: () => void;
  onNewWorkspace: () => void;
  onSelectThread: (id: string) => void;
  onSelectProject: (id: string) => void;
  onSelectWorkThread: (pid: string, tid: string) => void;
  onNewWorkThread: (pid: string) => void;
  onDelThread: (id: string, e: React.MouseEvent) => void;
  onDelProject: (id: string, e: React.MouseEvent) => void;
  onOpenFiles: (pid: string) => void;
  onOpenPlugins: () => void;
  onOpenInbox: () => void;
  onOpenSettings: () => void;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const isOpen = (pid: string) => (pid in collapsed ? !collapsed[pid] : pid === projectId);
  const chatThreads = threads.filter((t) => !t.projectId);

  return (
    <div className="ad-side">
      <div className="ad-side-actions">
        <button className="ad-side-act" onClick={onNewChat}>
          <NewChatIcon size={18} className="ad-side-act-ico" />
          <span>新对话</span>
          <span className="ad-side-kbd">⌘N</span>
        </button>
        <button className="ad-side-act" onClick={onNewWorkspace}>
          <FolderTreeIcon size={18} className="ad-side-act-ico" />
          <span>打开工作区</span>
        </button>
        <button className="ad-side-act" onClick={onOpenInbox}>
          <InboxIcon size={18} className="ad-side-act-ico" />
          <span>收件箱</span>
        </button>
        <button className={`ad-side-act ${mode === "plugins" ? "on" : ""}`} onClick={onOpenPlugins}>
          <PluginsIcon size={18} className="ad-side-act-ico" />
          <span>插件</span>
        </button>
      </div>

      <div className="ad-side-scroll">
        {/* 项目（工作区）分区 */}
        <div className="ad-side-eyebrow">项目</div>
        {projects.length === 0 ? (
          <div className="ad-side-hint">暂无项目</div>
        ) : (
          projects.map((p) => {
            const open = isOpen(p.id);
            const pThreads = threads.filter((t) => t.projectId === p.id);
            return (
              <div key={p.id} className="ad-side-group">
                <button
                  className={`ad-side-folder ${p.id === projectId ? "active" : ""}`}
                  title={p.workspaceDir}
                  onClick={() => {
                    onSelectProject(p.id);
                    setCollapsed((c) => ({ ...c, [p.id]: open ? true : false }));
                  }}
                >
                  <ChevronIcon size={12} className={`ad-side-chev ${open ? "open" : ""}`} />
                  <FolderClosedIcon size={14} className="ad-side-folder-ico" />
                  <span className="ad-side-folder-name">{p.name}</span>
                  {p.id === projectId && <span className="ad-side-cwd">CWD</span>}
                  <span
                    className="ad-task-del"
                    title="查看文件"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenFiles(p.id);
                    }}
                  >
                    <FolderTreeIcon size={12} />
                  </span>
                  <span className="ad-task-del" title="删除工作区" onClick={(e) => onDelProject(p.id, e)}>
                    <TrashIcon size={12} />
                  </span>
                </button>
                {open && (
                  <div className="ad-side-sub">
                    {pThreads.length === 0 && <div className="ad-side-hint sub">暂无对话</div>}
                    {pThreads.map((t) => {
                      const on = mode === "work" && p.id === projectId && t.id === workThreadId;
                      return (
                        <button
                          key={t.id}
                          className={`ad-task sub ${on ? "on" : ""}`}
                          onClick={() => onSelectWorkThread(p.id, t.id)}
                          title={t.title}
                        >
                          <span className={`ad-task-dot ${on ? "run" : ""}`} />
                          <span className="ad-task-name">{t.title || "新会话"}</span>
                          <span className="ad-task-del" title="删除" onClick={(e) => onDelThread(t.id, e)}>
                            <TrashIcon size={12} />
                          </span>
                        </button>
                      );
                    })}
                    <button className="ad-side-newsub" onClick={() => onNewWorkThread(p.id)}>
                      <PlusIcon size={12} /> 新建会话
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}

        {/* 对话（独立聊天）分区 */}
        <div className="ad-side-eyebrow gap">对话</div>
        {chatThreads.length === 0 ? (
          <div className="ad-side-hint">暂无聊天</div>
        ) : (
          chatThreads.map((t) => {
            const on = mode === "chat" && t.id === threadId;
            return (
              <button
                key={t.id}
                className={`ad-task ${on ? "on" : ""}`}
                onClick={() => onSelectThread(t.id)}
                title={t.title}
              >
                <span className={`ad-task-dot ${on ? "run" : ""}`} />
                <span className="ad-task-name">{t.title || "新会话"}</span>
                <span className="ad-task-time">{relTime(t.updatedAt)}</span>
                <span className="ad-task-del" title="删除" onClick={(e) => onDelThread(t.id, e)}>
                  <TrashIcon size={13} />
                </span>
              </button>
            );
          })
        )}
      </div>

      <div className="ad-side-foot">
        <button className="ad-side-set" onClick={onOpenSettings}>
          <GearIcon size={17} />
          <span>设置</span>
        </button>
        <span className="ad-spacer" />
        <span
          className={`ad-side-status ${status === "ok" ? "ok" : status === "connecting" ? "" : "err"}`}
          title={statusText}
        />
      </div>
    </div>
  );
}
