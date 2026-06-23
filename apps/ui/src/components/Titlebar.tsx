import {
  PanelIcon,
  PanelRightIcon,
  PanelRightCloseIcon,
  ArrowLeftIcon,
  ChevronIcon,
  FolderClosedIcon,
  GitBranchIcon,
} from "../icons.js";

/**
 * 顶部标题栏（dark-only · "Agent Tasks" 两段式，46px）：
 * - 段 A：宽 = 实时侧栏宽（带 1px 右边框；侧栏收起→auto 无边框）；macOS 原生红绿灯让位 + 侧栏开关 / 后退 / 前进。
 * - 段 B：面包屑（任务标题 + 工作区 pill + 分支 pill）+ 弹簧 + 工作台开关（动态图标，开/关不同）。
 */
export function Titlebar({
  sidebarOpen,
  sidebarWidth,
  onToggleSidebar,
  taskTitle,
  projectName,
  branch,
  isDesktop,
  showDock,
  dockOpen,
  onToggleDock,
}: {
  sidebarOpen: boolean;
  sidebarWidth: number;
  onToggleSidebar: () => void;
  taskTitle: string;
  projectName?: string;
  branch?: string;
  isDesktop: boolean;
  showDock: boolean;
  dockOpen: boolean;
  onToggleDock: () => void;
}) {
  return (
    <div className="ad-titlebar" data-tauri-drag-region>
      <div
        className={`ad-tb-seg-a ${sidebarOpen ? "bordered" : ""} ${isDesktop ? "desktop" : ""}`}
        style={sidebarOpen ? { width: sidebarWidth } : undefined}
      >
        <button className="ad-tb-nav" title="折叠/展开侧栏" onClick={onToggleSidebar}>
          <PanelIcon size={16} />
        </button>
        <button className="ad-tb-nav muted" title="后退" disabled>
          <ArrowLeftIcon size={16} />
        </button>
        <button className="ad-tb-nav muted" title="前进" disabled>
          <ChevronIcon size={16} />
        </button>
      </div>

      <div className="ad-tb-seg-b">
        <span className="ad-tb-task" title={taskTitle}>
          {taskTitle || "新任务"}
        </span>
        {projectName && (
          <span className="ad-tb-pill" title={projectName}>
            <FolderClosedIcon size={13} />
            <span className="mono">{projectName}</span>
          </span>
        )}
        {branch && (
          <span className="ad-tb-pill" title={branch}>
            <GitBranchIcon size={13} />
            <span className="mono">{branch}</span>
          </span>
        )}
        <span className="ad-spacer" />
        {showDock && (
          <button
            className={`ad-tb-dock ${dockOpen ? "on" : ""}`}
            title={dockOpen ? "关闭工作台" : "打开工作台（文件 / 浏览器 / 终端）"}
            onClick={onToggleDock}
          >
            {dockOpen ? <PanelRightCloseIcon size={17} /> : <PanelRightIcon size={17} />}
          </button>
        )}
      </div>
    </div>
  );
}
