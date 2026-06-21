import type { Project } from "@ew/shared";
import type { Mode } from "./IconRail.js";
import { PlusIcon, SearchIcon, ChatIcon, FolderClosedIcon, TrashIcon, InboxIcon } from "../icons.js";

interface ThreadItem {
  id: string;
  title: string;
  updatedAt: string;
  projectId?: string;
}

/** Agent Desk 会话列表：对话=最近 thread；工作区=项目；收件箱=渠道（最小空态）。 */
export function SessionList({
  mode,
  threads,
  projects,
  threadId,
  projectId,
  onNewChat,
  onNewWorkspace,
  onSelectThread,
  onSelectProject,
  onDelThread,
  onDelProject,
}: {
  mode: Mode;
  threads: ThreadItem[];
  projects: Project[];
  threadId: string;
  projectId: string | null;
  onNewChat: () => void;
  onNewWorkspace: () => void;
  onSelectThread: (id: string) => void;
  onSelectProject: (id: string) => void;
  onDelThread: (id: string, e: React.MouseEvent) => void;
  onDelProject: (id: string, e: React.MouseEvent) => void;
}) {
  const title = mode === "work" ? "工作区" : mode === "inbox" ? "收件箱" : "最近对话";
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
          (threads.length === 0 ? (
            <div className="ad-sl-empty">还没有会话</div>
          ) : (
            threads.map((t) => (
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
            projects.map((p) => (
              <button
                key={p.id}
                className={`ad-sl-row ${p.id === projectId ? "on" : ""}`}
                onClick={() => onSelectProject(p.id)}
                title={p.workspaceDir}
              >
                <FolderClosedIcon size={14} className="ad-sl-ico" />
                <span className="ad-sl-name mono">{p.name}</span>
                <span className="ad-sl-del" title="删除" onClick={(e) => onDelProject(p.id, e)}>
                  <TrashIcon size={13} />
                </span>
              </button>
            ))
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
