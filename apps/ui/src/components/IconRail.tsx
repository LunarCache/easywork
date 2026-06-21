import { SparkIcon, ChatIcon, FolderTreeIcon, InboxIcon, BrainIcon, GearIcon, GlobeIcon } from "../icons.js";

export type Mode = "chat" | "work" | "inbox";
type Status = "connecting" | "ok" | "unauthorized" | "unreachable";

const MODES: { id: Mode; label: string; Icon: typeof ChatIcon; title: string }[] = [
  { id: "chat", label: "对话", Icon: ChatIcon, title: "对话 — 日常任务，不绑定仓库" },
  { id: "work", label: "工作区", Icon: FolderTreeIcon, title: "工作区 — 在代码仓库里干活" },
  { id: "inbox", label: "收件箱", Icon: InboxIcon, title: "收件箱 — 已连接的 IM 渠道" },
];

/** Agent Desk 左侧图标轨道：logo + 模式切换(对话/工作区/收件箱) + 记忆/设置 + 账户。 */
export function IconRail({
  mode,
  setMode,
  onMemory,
  onSettings,
  status,
  statusText,
}: {
  mode: Mode;
  setMode: (m: Mode) => void;
  onMemory: () => void;
  onSettings: () => void;
  status: Status;
  statusText: string;
}) {
  return (
    <div className="ad-rail">
      <span className="ad-rail-logo">
        <SparkIcon size={17} />
      </span>
      {MODES.map(({ id, label, Icon, title }) => (
        <button
          key={id}
          className={`ad-rail-mode ${mode === id ? "on" : ""}`}
          title={title}
          onClick={() => setMode(id)}
        >
          <Icon size={19} />
          <span>{label}</span>
        </button>
      ))}
      <div className="ad-rail-div" />
      <button className="ad-rail-btn" title="记忆" onClick={onMemory}>
        <BrainIcon size={18} />
      </button>
      <button className="ad-rail-btn" title="设置" onClick={onSettings}>
        <GearIcon size={18} />
      </button>
      <span className="ad-rail-grow" />
      <span className={`ad-rail-acct ${status === "ok" ? "ok" : status === "connecting" ? "" : "err"}`} title={statusText}>
        <GlobeIcon size={15} />
      </span>
    </div>
  );
}
