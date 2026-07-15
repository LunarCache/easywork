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
        data-tauri-drag-region
      >
        <button className="ad-tb-nav" title="折叠/展开侧栏" onClick={onToggleSidebar}>
          <PanelIcon size={16} />
        </button>
        <span className="ad-tb-nav ad-tb-nav-static muted" title="后退" aria-hidden="true" data-tauri-drag-region>
          <ArrowLeftIcon size={16} data-tauri-drag-region />
        </span>
        <span className="ad-tb-nav ad-tb-nav-static muted" title="前进" aria-hidden="true" data-tauri-drag-region>
          <ChevronIcon size={16} data-tauri-drag-region />
        </span>
      </div>

      <div className="ad-tb-seg-b" data-tauri-drag-region>
        <span className="ad-tb-task" title={taskTitle} data-tauri-drag-region>
          {taskTitle || "新任务"}
        </span>
        {projectName && (
          <span className="ad-tb-pill" title={projectName} data-tauri-drag-region>
            <FolderClosedIcon size={13} data-tauri-drag-region />
            <span className="mono" data-tauri-drag-region>
              {projectName}
            </span>
          </span>
        )}
        {branch && (
          <span className="ad-tb-pill" title={branch} data-tauri-drag-region>
            <GitBranchIcon size={13} data-tauri-drag-region />
            <span className="mono" data-tauri-drag-region>
              {branch}
            </span>
          </span>
        )}
        <span className="ad-spacer" data-tauri-drag-region />
        {showDock && (
          <div
            className={`ad-tb-dock-area ${dockOpen ? "open" : ""}`}
            data-testid="side-dock-titlebar-area"
            data-tauri-drag-region
          >
            <div
              id="side-dock-titlebar-host"
              className="ad-tb-dock-host"
              data-testid="side-dock-titlebar-host"
              data-tauri-drag-region
            />
            <button
              className={`ad-tb-dock ${dockOpen ? "on" : ""}`}
              title={dockOpen ? "关闭工作台" : "打开工作台"}
              onClick={onToggleDock}
            >
              {dockOpen ? <PanelRightCloseIcon size={17} /> : <PanelRightIcon size={17} />}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
