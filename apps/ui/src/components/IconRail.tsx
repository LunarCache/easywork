import {
  EasyWorkLogo,
  ChatIcon,
  FolderTreeIcon,
  InboxIcon,
  BoxIcon,
  BookIcon,
  SparkIcon,
  WrenchIcon,
  BrainIcon,
  GlobeIcon,
} from "../icons.js";

export type Mode = "chat" | "work" | "inbox";
export type Tool = "models" | "kb" | "skills" | "mcp" | "memory";
type Status = "connecting" | "ok" | "unauthorized" | "unreachable";

const MODES: { id: Mode; label: string; Icon: typeof ChatIcon; title: string }[] = [
  { id: "chat", label: "对话", Icon: ChatIcon, title: "对话 — 日常任务，不绑定仓库" },
  { id: "work", label: "工作区", Icon: FolderTreeIcon, title: "工作区 — 在代码仓库里干活" },
  { id: "inbox", label: "收件箱", Icon: InboxIcon, title: "收件箱 — 已连接的 IM 渠道" },
];

const TOOLS: { id: Tool; title: string; Icon: typeof ChatIcon }[] = [
  { id: "models", title: "模型", Icon: BoxIcon },
  { id: "kb", title: "知识库", Icon: BookIcon },
  { id: "skills", title: "Skills", Icon: SparkIcon },
  { id: "mcp", title: "MCP", Icon: WrenchIcon },
  { id: "memory", title: "记忆", Icon: BrainIcon },
];

/** Agent Desk 左侧图标轨道：logo + 模式切换(对话/工作区/收件箱) + 工具(模型/知识库/Skills/MCP/记忆) + 账户。 */
export function IconRail({
  mode,
  setMode,
  onOpen,
  status,
  statusText,
}: {
  mode: Mode;
  setMode: (m: Mode) => void;
  onOpen: (tool: Tool) => void;
  status: Status;
  statusText: string;
}) {
  return (
    <div className="ad-rail">
      <span className="ad-rail-logo" title="EasyWork">
        <EasyWorkLogo size={30} />
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
      {TOOLS.map(({ id, title, Icon }) => (
        <button key={id} className="ad-rail-btn" title={title} onClick={() => onOpen(id)}>
          <Icon size={18} />
        </button>
      ))}
      <span className="ad-rail-grow" />
      <span className={`ad-rail-acct ${status === "ok" ? "ok" : status === "connecting" ? "" : "err"}`} title={statusText}>
        <GlobeIcon size={15} />
      </span>
    </div>
  );
}
