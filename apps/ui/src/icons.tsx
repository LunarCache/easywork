import { useId } from "react";

// 图标统一用 lucide-react（与 Unsloth Studio 一致），以现有命名再导出，组件无需改动。
export {
  MessageSquare as ChatIcon,
  Package as BoxIcon,
  SlidersHorizontal as SlidersIcon,
  Send as SendIcon,
  Search as SearchIcon,
  ChevronsDownUp as CollapseAllIcon,
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
  RotateCw as ReloadIcon,
  GitBranch as GitBranchIcon,
  GitFork as GitGraphIcon,
  Play as PlayIcon,
  FolderPlus as FolderPlusIcon,
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

/** EasyWork 应用图标：Ewo 的机器人头像。与 src-tauri/icons/icon.svg 同源。 */
export function EasyWorkLogo({ size = 30 }: { size?: number }) {
  const id = `ewl-${useId().replaceAll(":", "")}`;

  return (
    <svg width={size} height={size} viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-bg`} x1="0.1" y1="0" x2="0.9" y2="1">
          <stop offset="0" stopColor="var(--logo-bg-start)" />
          <stop offset="1" stopColor="var(--logo-bg-end)" />
        </linearGradient>
        <linearGradient id={`${id}-shell`} x1="0.18" y1="0" x2="0.82" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#dce5e4" />
        </linearGradient>
        <radialGradient id={`${id}-screen`} cx="0.5" cy="0.25" r="0.9">
          <stop offset="0" stopColor="#26363b" />
          <stop offset="1" stopColor="#152126" />
        </radialGradient>
        <linearGradient id={`${id}-mark`} x1="0" y1="0" x2="0.4" y2="1">
          <stop offset="0" stopColor="var(--logo-mark-start)" />
          <stop offset="1" stopColor="var(--logo-mark-end)" />
        </linearGradient>
      </defs>
      <rect x="112" y="112" width="800" height="800" rx="188" fill={`url(#${id}-bg)`} />
      <rect x="113.5" y="113.5" width="797" height="797" rx="186.5" fill="none" stroke="var(--logo-border)" strokeWidth="3" />
      <rect x="478" y="237" width="68" height="50" rx="21" fill="#344349" />
      <rect x="496" y="193" width="32" height="64" rx="16" fill="#6e7c80" />
      <path d="M512 137C522 170 534 182 567 192C534 202 522 214 512 247C502 214 490 202 457 192C490 182 502 170 512 137Z" fill="var(--logo-glow)" />
      <rect x="185" y="432" width="86" height="184" rx="42" fill="#344349" />
      <rect x="753" y="432" width="86" height="184" rx="42" fill="#344349" />
      <rect x="202" y="458" width="42" height="132" rx="21" fill="#536267" />
      <rect x="780" y="458" width="42" height="132" rx="21" fill="#536267" />
      <rect x="226" y="292" width="572" height="494" rx="154" fill={`url(#${id}-shell)`} stroke="#c7d2d2" strokeWidth="5" />
      <rect x="272" y="374" width="480" height="306" rx="92" fill={`url(#${id}-screen)`} stroke="#0f191d" strokeWidth="7" />
      <path d="M300 422C382 384 642 384 724 422" fill="none" stroke="#ffffff" strokeOpacity="0.08" strokeWidth="18" strokeLinecap="round" />
      <g fill={`url(#${id}-mark)`}>
        <rect x="356" y="447" width="54" height="166" rx="27" />
        <rect x="356" y="447" width="130" height="54" rx="27" />
        <rect x="356" y="503" width="108" height="54" rx="27" />
        <rect x="356" y="559" width="130" height="54" rx="27" />
      </g>
      <path d="M590 468L658 530L590 592" fill="none" stroke="#ffffff" strokeWidth="42" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="418" y="758" width="188" height="50" rx="25" fill="#344349" />
      <rect x="452" y="770" width="120" height="22" rx="11" fill="#536267" />
    </svg>
  );
}

/** Ewo 全身卡通形象，用于产品空状态；无文字，缩小后仍保持清晰。 */
export function EasyWorkMascot({ size = 88, className }: { size?: number; className?: string }) {
  const id = `ewm-${useId().replaceAll(":", "")}`;

  return (
    <svg
      className={className}
      width={size}
      height={size * 1.12}
      viewBox="0 0 260 292"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={`${id}-shell`} x1="0.15" y1="0" x2="0.85" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#dce5e4" />
        </linearGradient>
        <linearGradient id={`${id}-mark`} x1="0" y1="0" x2="0.8" y2="1">
          <stop offset="0" stopColor="var(--logo-mark-start)" />
          <stop offset="1" stopColor="var(--logo-mark-end)" />
        </linearGradient>
      </defs>

      <ellipse cx="128" cy="278" rx="75" ry="9" fill="var(--text)" opacity="0.08" />

      <rect x="121" y="25" width="16" height="29" rx="8" fill="#66767b" />
      <path d="M129 2C133 16 138 21 152 25C138 29 133 34 129 48C125 34 120 29 106 25C120 21 125 16 129 2Z" fill={`url(#${id}-mark)`} />

      <g stroke="#c4d0cf" strokeWidth="2">
        <rect x="43" y="58" width="172" height="124" rx="48" fill={`url(#${id}-shell)`} />
        <rect x="30" y="91" width="24" height="57" rx="12" fill="#435259" stroke="#344349" />
        <rect x="204" y="91" width="24" height="57" rx="12" fill="#435259" stroke="#344349" />
      </g>
      <rect x="58" y="78" width="142" height="82" rx="29" fill="#17252a" />
      <path d="M69 91C95 80 163 80 190 91" fill="none" stroke="#ffffff" strokeOpacity="0.08" strokeWidth="7" strokeLinecap="round" />
      <g fill={`url(#${id}-mark)`}>
        <rect x="85" y="99" width="13" height="42" rx="6.5" />
        <rect x="85" y="99" width="36" height="13" rx="6.5" />
        <rect x="85" y="114" width="30" height="13" rx="6.5" />
        <rect x="85" y="128" width="36" height="13" rx="6.5" />
      </g>
      <path d="M145 104L166 120L145 136" fill="none" stroke="#ffffff" strokeWidth="10" strokeLinecap="round" strokeLinejoin="round" />

      <rect x="105" y="176" width="48" height="20" rx="10" fill="#344349" />
      <path d="M83 183C83 172 92 163 103 163H155C166 163 175 172 175 183L181 239C182 251 173 261 161 261H97C85 261 76 251 77 239L83 183Z" fill={`url(#${id}-shell)`} stroke="#c4d0cf" strokeWidth="2" />
      <rect x="112" y="190" width="34" height="11" rx="5.5" fill={`url(#${id}-mark)`} />
      <circle cx="129" cy="217" r="6" fill="#526267" />

      <circle cx="81" cy="194" r="13" fill="#344349" />
      <path d="M79 194C61 198 52 213 49 233" fill="none" stroke="#dce5e4" strokeWidth="20" strokeLinecap="round" />
      <circle cx="47" cy="238" r="11" fill="#344349" />

      <circle cx="177" cy="190" r="13" fill="#344349" />
      <path d="M179 190C196 179 202 163 204 143" fill="none" stroke="#dce5e4" strokeWidth="20" strokeLinecap="round" />
      <circle cx="205" cy="137" r="11" fill="#344349" />
      <path d="M205 128V112M198 131L188 119M212 130L221 118" fill="none" stroke="#dce5e4" strokeWidth="8" strokeLinecap="round" />

      <rect x="91" y="252" width="29" height="24" rx="12" fill="#344349" />
      <rect x="138" y="252" width="29" height="24" rx="12" fill="#344349" />
      <path d="M102 269H81C75 269 70 274 70 280H112C112 274 108 269 102 269Z" fill="#27363c" />
      <path d="M156 269H177C183 269 188 274 188 280H146C146 274 150 269 156 269Z" fill="#27363c" />
      <path d="M87 280H112M146 280H171" stroke={`url(#${id}-mark)`} strokeWidth="5" strokeLinecap="round" />
    </svg>
  );
}
