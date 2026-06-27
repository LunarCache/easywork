import { useEffect, useState } from "react";
import { type Appearance, type ThemePrefs } from "../lib/prefs.js";
import { Models } from "./Models.js";
import { Skills } from "./Skills.js";
import { Mcp } from "./Mcp.js";
import { KnowledgeBaseOverlay } from "../components/KnowledgeBaseOverlay.js";
import { MemoryOverlay } from "../components/MemoryOverlay.js";
import {
  PaletteIcon,
  SunIcon,
  MoonIcon,
  MonitorIcon,
  ArrowLeftIcon,
  BoxIcon,
  BookIcon,
  SparkIcon,
  BrainIcon,
  PluginsIcon,
  ChevronDownIcon,
  CheckIcon,
} from "../icons.js";

export type SettingsSection = "general" | "models" | "kb" | "skills" | "mcp" | "memory";


const APPEARANCES: { id: Appearance; label: string; Icon: typeof SunIcon }[] = [
  { id: "light", label: "浅色", Icon: SunIcon },
  { id: "dark", label: "深色", Icon: MoonIcon },
  { id: "system", label: "跟随系统", Icon: MonitorIcon },
];
/** 主题下拉：自绘深色弹层（原生 <select> 的选项菜单是 OS 浅色绘制，无法随主题着色）。 */
function AppearanceSelect({ value, onChange }: { value: Appearance; onChange: (a: Appearance) => void }) {
  const [open, setOpen] = useState(false);
  const cur = APPEARANCES.find((a) => a.id === value) ?? APPEARANCES[1]!;
  return (
    <div className="set-select-wrap">
      <button className={`set-select-btn ${open ? "open" : ""}`} onClick={() => setOpen((o) => !o)}>
        <cur.Icon size={14} />
        <span>{cur.label}</span>
        <ChevronDownIcon size={13} className="set-select-chev" />
      </button>
      {open && (
        <>
          <div className="menu-backdrop" onClick={() => setOpen(false)} />
          <div className="set-select-menu">
            {APPEARANCES.map(({ id, label, Icon }) => (
              <button
                key={id}
                className={`set-select-opt ${id === value ? "on" : ""}`}
                onClick={() => {
                  onChange(id);
                  setOpen(false);
                }}
              >
                <Icon size={14} />
                <span>{label}</span>
                {id === value && <CheckIcon size={14} className="set-select-check" />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function Settings({
  theme,
  navWidth,
  initialSection,
  onSectionChange,
  onThemeChange,
  onBack,
  onModelsChange,
}: {
  theme: ThemePrefs;
  /** 与主侧栏同宽，保证设置页的左栏分割线与默认页对齐。 */
  navWidth?: number;
  initialSection?: SettingsSection;
  onSectionChange?: (section: SettingsSection) => void;
  onThemeChange: (next: ThemePrefs) => void;
  onBack: () => void;
  onModelsChange: () => void;
}) {
  const start = initialSection ?? "general";
  const [sec, setSec] = useState<SettingsSection>(start);
  // 已访问的「页」型分区保持挂载（CSS 隐藏非当前），避免切走丢状态（如知识库上传/索引轮询）。
  const [visited, setVisited] = useState<Set<SettingsSection>>(() => new Set<SettingsSection>([start]));
  const openSec = (id: SettingsSection) => {
    setVisited((v) => (v.has(id) ? v : new Set(v).add(id)));
    setSec(id);
    onSectionChange?.(id);
  };
  const SECS: { id: SettingsSection; label: string; Icon: typeof PaletteIcon }[] = [
    { id: "general", label: "通用", Icon: PaletteIcon },
    { id: "models", label: "模型", Icon: BoxIcon },
    { id: "kb", label: "知识库", Icon: BookIcon },
    { id: "skills", label: "Skills", Icon: SparkIcon },
    { id: "mcp", label: "MCP", Icon: PluginsIcon },
    { id: "memory", label: "记忆", Icon: BrainIcon },
  ];
  // 「卡片行」型分区（自带标题 + 卡片）；其余是直接铺满的管理页（自带头部）。
  const CARD_SECS = new Set<SettingsSection>(["general"]);

  useEffect(() => {
    if (!initialSection) return;
    setSec(initialSection);
    setVisited((v) => (v.has(initialSection) ? v : new Set(v).add(initialSection)));
  }, [initialSection]);

  return (
    <div className="set-page">
      <div className="set-nav" style={navWidth ? { width: navWidth } : undefined} data-tauri-drag-region>
        <button className="set-back" onClick={onBack}>
          <ArrowLeftIcon size={15} /> 返回工作区
        </button>
        {SECS.map(({ id, label, Icon }) => (
          <button key={id} className={`set-navi ${sec === id ? "on" : ""}`} onClick={() => openSec(id)}>
            <Icon size={16} /> {label}
          </button>
        ))}
      </div>

      <div className="set-main">
        <div className="set-phead">
          <h1 className="set-title">{SECS.find((s) => s.id === sec)?.label}</h1>
        </div>
        <div className="set-mbody">
        {CARD_SECS.has(sec) && (
          <div className="set-content">
            {sec === "general" && (
              <div className="set-group">
                <div className="set-row">
                  <div className="set-row-info">
                    <div className="set-row-title">界面主题</div>
                    <div className="set-row-desc">切换应用界面使用的主题外观。</div>
                  </div>
                  <AppearanceSelect value={theme.appearance} onChange={(a) => onThemeChange({ ...theme, appearance: a })} />
                </div>
              </div>
            )}
          </div>
        )}
        {visited.has("models") && (
          <div className={`set-pane ${sec === "models" ? "" : "hidden"}`}>
            <Models onChange={onModelsChange} />
          </div>
        )}
        {visited.has("kb") && (
          <div className={`set-pane ${sec === "kb" ? "" : "hidden"}`}>
            <KnowledgeBaseOverlay embedded />
          </div>
        )}
        {visited.has("skills") && (
          <div className={`set-pane ${sec === "skills" ? "" : "hidden"}`}>
            <Skills />
          </div>
        )}
        {visited.has("mcp") && (
          <div className={`set-pane ${sec === "mcp" ? "" : "hidden"}`}>
            <Mcp />
          </div>
        )}
        {visited.has("memory") && (
          <div className={`set-pane ${sec === "memory" ? "" : "hidden"}`}>
            <MemoryOverlay embedded />
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
