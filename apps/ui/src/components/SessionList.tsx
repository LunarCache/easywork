import { useState } from "react";
import type { Project } from "@ew/shared";
import type { Mode } from "./IconRail.js";
import {
  PlusIcon,
  SearchIcon,
  ChatIcon,
  FolderClosedIcon,
  FolderTreeIcon,
  TrashIcon,
  InboxIcon,
  ChevronIcon,
} from "../icons.js";

interface ThreadItem {
  id: string;
  title: string;
  updatedAt: string;
  projectId?: string;
}

/** Agent Desk 会话列表：对话=最近 thread；工作区=项目分组→其会话；收件箱=渠道（最小空态）。 */
export function SessionList({
  mode,
  threads,
  projects,
  threadId,
  projectId,
  workThreadId,
  onNewChat,
  onNewWorkspace,
  onSelectThread,
  onSelectProject,
  onSelectWorkThread,
  onNewWorkThread,
  onDelThread,
  onDelProject,
  onOpenFiles,
}: {
  mode: Mode;
  threads: ThreadItem[];
  projects: Project[];
  threadId: string;
  projectId: string | null;
  workThreadId: string;
  onNewChat: () => void;
  onNewWorkspace: () => void;
  onSelectThread: (id: string) => void;
  onSelectProject: (id: string) => void;
  onSelectWorkThread: (pid: string, tid: string) => void;
  onNewWorkThread: (pid: string) => void;
  onDelThread: (id: string, e: React.MouseEvent) => void;
  onDelProject: (id: string, e: React.MouseEvent) => void;
  /** 点击项目「查看文件」图标 → 主区切到该项目的文件浏览页。 */
  onOpenFiles: (pid: string) => void;
}) {
  // 工作区分组展开态（默认展开当前项目）。
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const isOpen = (pid: string) => (pid in collapsed ? !collapsed[pid] : pid === projectId);
  const title = mode === "work" ? "工作区" : mode === "inbox" ? "收件箱" : "最近对话";
  const chatThreads = threads.filter((t) => !t.projectId);

  return (
    <div className="ad-sessions">
      <div className="ad-sl-head">
        <span className="ad-sl-title">{title}</span>
        {mode === "chat" && (
          <button className="ad-sl-new" title="新对话" onClick={onNewChat}>
            <PlusIcon size={14} />
          </button>
        )}
        {mode === "work" && (
          <button className="ad-sl-new" title="新建工作区" onClick={onNewWorkspace}>
            <PlusIcon size={14} />
          </button>
        )}
      </div>

      {mode !== "inbox" && (
        <div className="ad-sl-search">
          <SearchIcon size={14} />
          <span>搜索…</span>
        </div>
      )}

      <div className="ad-sl-scroll">
        {mode === "chat" &&
          (chatThreads.length === 0 ? (
            <div className="ad-sl-empty">还没有会话</div>
          ) : (
            chatThreads.map((t) => (
              <button
                key={t.id}
                className={`ad-sl-row ${t.id === threadId ? "on" : ""}`}
                onClick={() => onSelectThread(t.id)}
                title={t.title}
              >
                <ChatIcon size={14} className="ad-sl-ico" />
                <span className="ad-sl-name">{t.title || "新会话"}</span>
                <span className="ad-sl-del" title="删除" onClick={(e) => onDelThread(t.id, e)}>
                  <TrashIcon size={13} />
                </span>
              </button>
            ))
          ))}

        {mode === "work" &&
          (projects.length === 0 ? (
            <div className="ad-sl-empty">还没有工作区</div>
          ) : (
            projects.map((p) => {
              const open = isOpen(p.id);
              const pThreads = threads.filter((t) => t.projectId === p.id);
              return (
                <div key={p.id} className="ad-sl-group">
                  <button
                    className={`ad-sl-grouphead ${p.id === projectId ? "active" : ""}`}
                    title={p.workspaceDir}
                    onClick={() => {
                      onSelectProject(p.id);
                      setCollapsed((c) => ({ ...c, [p.id]: open ? true : false }));
                    }}
                  >
                    <ChevronIcon size={12} className={`ad-sl-chev ${open ? "open" : ""}`} />
                    <FolderClosedIcon size={13} className="ad-sl-ico" />
                    <span className="ad-sl-name mono">{p.name}</span>
                    {p.id === projectId && <span className="ad-sl-cwd">CWD</span>}
                    <span className="ad-sl-count">{pThreads.length}</span>
                    <span
                      className="ad-sl-files-btn"
                      title="查看文件"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenFiles(p.id);
                      }}
                    >
                      <FolderTreeIcon size={12} />
                    </span>
                    <span className="ad-sl-del" title="删除工作区" onClick={(e) => onDelProject(p.id, e)}>
                      <TrashIcon size={12} />
                    </span>
                  </button>
                  {open && (
                    <div className="ad-sl-sub">
                      {pThreads.map((t) => (
                        <button
                          key={t.id}
                          className={`ad-sl-row sub ${p.id === projectId && t.id === workThreadId ? "on" : ""}`}
                          onClick={() => onSelectWorkThread(p.id, t.id)}
                          title={t.title}
                        >
                          <span className="ad-sl-dot" />
                          <span className="ad-sl-name">{t.title || "新会话"}</span>
                          <span className="ad-sl-del" title="删除" onClick={(e) => onDelThread(t.id, e)}>
                            <TrashIcon size={12} />
                          </span>
                        </button>
                      ))}
                      <button className="ad-sl-newsub" onClick={() => onNewWorkThread(p.id)}>
                        <PlusIcon size={12} /> 新建会话
                      </button>
                    </div>
                  )}
                </div>
              );
            })
          ))}

        {mode === "inbox" && (
          <div className="ad-sl-inbox-empty">
            <InboxIcon size={26} />
            <p>未连接渠道</p>
            <span>连接 Telegram / 企业微信 / 飞书等 IM 后，会话会出现在这里。</span>
          </div>
        )}
      </div>
    </div>
  );
}
