// 图标统一用 lucide-react（与 Unsloth Studio 一致），以现有命名再导出，组件无需改动。
export {
  MessageSquare as ChatIcon,
  Package as BoxIcon,
  SlidersHorizontal as SlidersIcon,
  Send as SendIcon,
  Search as SearchIcon,
  Sparkles as SparkIcon,
  Download as DownloadIcon,
  Brain as BrainIcon,
  LayoutGrid as PluginsIcon,
  Wrench as WrenchIcon,
  ChevronRight as ChevronIcon,
  Check as CheckIcon,
  Plus as PlusIcon,
  Trash2 as TrashIcon,
  Copy as CopyIcon,
  SquarePen as NewChatIcon,
  PanelLeft as PanelIcon,
  PanelRight as PanelRightIcon,
  PanelRightClose as PanelRightCloseIcon,
  Lightbulb as ThinkIcon,
  Globe as GlobeIcon,
  Code2 as CodeIcon,
  ArrowUp as ArrowUpIcon,
  ArrowLeft as ArrowLeftIcon,
  Mic as MicIcon,
  Plus as PlusBtnIcon,
  Database as KbIcon,
  BookOpen as BookIcon,
  FileText as FileIcon,
  UploadCloud as UploadIcon,
  Loader as LoaderIcon,
  FolderOpen as FolderIcon,
  PencilLine as EditIcon,
  FolderTree as FolderTreeIcon,
  Folder as FolderClosedIcon,
  Terminal as TerminalIcon,
  SquareTerminal as SquareTerminalIcon,
  GitCompare as DiffIcon,
  FilePlus as FilePlusIcon,
  FileCode as FileCodeIcon,
  FileJson as FileJsonIcon,
  FileSpreadsheet as FileSpreadsheetIcon,
  FileImage as FileImageIcon,
  FileTerminal as FileTerminalIcon,
  ChevronDown as ChevronDownIcon,
  Clock as ClockIcon,
  ShieldCheck as ShieldIcon,
  RefreshCw as RefreshIcon,
  GitBranch as GitBranchIcon,
  Undo2 as UndoIcon,
  GitCommitHorizontal as CommitIcon,
  Sun as SunIcon,
  Moon as MoonIcon,
  Monitor as MonitorIcon,
  Palette as PaletteIcon,
  Square as StopIcon,
  X as XIcon,
  Maximize2 as MaximizeIcon,
  Minimize2 as MinimizeIcon,
  CornerDownLeft as EnterIcon,
  TriangleAlert as AlertIcon,
  Inbox as InboxIcon,
  Settings as GearIcon,
  History as HistoryIcon,
  User as UserIcon,
  AlignJustify as DensityIcon,
} from "lucide-react";

/** EasyWork 应用图标（浅色圆角方 + iris「E」+ 双 spark）。与 src-tauri/icons/icon.svg 同源。 */
export function EasyWorkLogo({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <linearGradient id="ewl-bg" x1="0.1" y1="0" x2="0.9" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#EDEEF4" />
        </linearGradient>
        <radialGradient id="ewl-glow" cx="0.5" cy="0.46" r="0.55">
          <stop offset="0" stopColor="#5256E0" stopOpacity="0.14" />
          <stop offset="1" stopColor="#5256E0" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="ewl-mark" x1="0" y1="0" x2="0.4" y2="1">
          <stop offset="0" stopColor="#5B5FEA" />
          <stop offset="1" stopColor="#4145CE" />
        </linearGradient>
      </defs>
      <rect x="112" y="112" width="800" height="800" rx="188" fill="url(#ewl-bg)" />
      <rect x="113.5" y="113.5" width="797" height="797" rx="186.5" fill="none" stroke="#D6DAE6" strokeWidth="3" />
      <circle cx="500" cy="512" r="300" fill="url(#ewl-glow)" />
      <g fill="url(#ewl-mark)">
        <rect x="330" y="300" width="98" height="424" rx="49" />
        <rect x="330" y="300" width="300" height="98" rx="49" />
        <rect x="330" y="463" width="232" height="98" rx="49" />
        <rect x="330" y="626" width="300" height="98" rx="49" />
      </g>
      <path
        d="M704 300 C715 348 731 364 779 375 C731 386 715 402 704 450 C693 402 677 386 629 375 C677 364 693 348 704 300 Z"
        fill="#5256E0"
      />
      <path
        d="M662 470 C668 494 678 504 702 510 C678 516 668 526 662 550 C656 526 646 516 622 510 C646 504 656 494 662 470 Z"
        fill="#5256E0"
        opacity="0.8"
      />
    </svg>
  );
}
