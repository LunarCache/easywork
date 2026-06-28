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
  InboxIcon,
  SearchIcon,
  CollapseAllIcon,
} from "../icons.js";

export type Mode = "chat" | "work" | "inbox";
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
 * 展开式侧栏（参考设计）：顶部快捷操作（新对话 / 打开工作区 / 收件箱）+
 * 分区列表「项目」（工作区折叠组）与「对话」（独立聊天线程）+ 底部「设置」。
 * 模型 / 知识库 / Skills / MCP / 记忆 已并入「设置」（齿轮）的左导航。
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
  onOpenInbox,
  onOpenSettings,
  onOpenSearch,
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
  onOpenInbox: () => void;
  onOpenSettings: () => void;
  onOpenSearch?: () => void;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const isOpen = (pid: string) => (pid in collapsed ? !collapsed[pid] : pid === projectId);
  // 折叠全部 / 展开全部：任一展开 → 全折叠；否则全展开。
  const anyOpen = projects.some((p) => isOpen(p.id));
  const toggleAll = () => setCollapsed(Object.fromEntries(projects.map((p) => [p.id, anyOpen])));
  const chatThreads = threads.filter((t) => !t.projectId);

  return (
    <div className="ad-side">
      <div className="ad-side-actions">
        <button className="ad-side-act" onClick={onNewChat}>
          <NewChatIcon size={18} className="ad-side-act-ico" />
          <span>新对话</span>
          <span className="ad-side-kbd">⌘N</span>
        </button>
        {onOpenSearch && (
          <button className="ad-side-act" data-testid="sidebar-search" onClick={onOpenSearch}>
            <SearchIcon size={18} className="ad-side-act-ico" />
            <span>搜索</span>
            <span className="ad-side-kbd">⌘K</span>
          </button>
        )}
        <button className="ad-side-act" onClick={onNewWorkspace}>
          <FolderTreeIcon size={18} className="ad-side-act-ico" />
          <span>打开工作区</span>
        </button>
        <button className="ad-side-act" onClick={onOpenInbox}>
          <InboxIcon size={18} className="ad-side-act-ico" />
          <span>收件箱</span>
        </button>
      </div>

      <div className="ad-side-scroll">
        {/* 项目（工作区）分区 */}
        <div className="ad-side-eyebrow bar">
          <span>项目</span>
          {projects.length > 1 && (
            <button
              className="ad-eyebrow-act"
              title={anyOpen ? "折叠全部" : "展开全部"}
              onClick={toggleAll}
            >
              <CollapseAllIcon size={13} />
            </button>
          )}
        </div>
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
                  data-testid={`sidebar-project-${p.id}`}
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
                    title="新建会话"
                    onClick={(e) => {
                      e.stopPropagation();
                      onNewWorkThread(p.id);
                    }}
                  >
                    <PlusIcon size={13} />
                  </span>
                  <span
                    className="ad-task-del"
                    data-testid={`sidebar-project-files-${p.id}`}
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
                          <span className="ad-task-time">{relTime(t.updatedAt)}</span>
                          <span className="ad-task-del" title="删除" onClick={(e) => onDelThread(t.id, e)}>
                            <TrashIcon size={12} />
                          </span>
                        </button>
                      );
                    })}
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
        <button className="ad-side-set" data-testid="sidebar-settings" onClick={onOpenSettings}>
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
