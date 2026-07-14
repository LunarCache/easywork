import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { type Appearance, type ThemePrefs } from "../lib/prefs.js";
import { Models } from "../pages/Models.js";
import { Skills } from "../pages/Skills.js";
import { Mcp } from "../pages/Mcp.js";
import { Channels } from "../pages/Channels.js";
import { MemoryOverlay } from "../components/MemoryOverlay.js";
import {
  PaletteIcon,
  SunIcon,
  MoonIcon,
  MonitorIcon,
  ArrowLeftIcon,
  BoxIcon,
  SparkIcon,
  BrainIcon,
  PluginsIcon,
  GitGraphIcon,
  ChevronDownIcon,
  CheckIcon,
} from "../icons.js";
import { SkillAttentionBadge, type SkillAttention } from "../components/SkillAttentionBadge.js";

export type SettingsSection = "general" | "models" | "channels" | "skills" | "mcp" | "memory";

type SettingsIcon = typeof PaletteIcon;

type SettingsPaneKind = "card" | "page";

interface SettingsSectionDefinition {
  id: SettingsSection;
  label: string;
  Icon: SettingsIcon;
  kind: SettingsPaneKind;
  keepAlive?: boolean;
  render(): ReactNode;
}

export interface SettingsPageHostProps {
  theme: ThemePrefs;
  navWidth?: number;
  section: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
  onThemeChange: (next: ThemePrefs) => void;
  onBack: () => void;
  onModelsChange: () => void;
  skillAttention?: SkillAttention;
}

const SETTINGS_SEC_KEY = "ew.settingsSection";

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  "general",
  "models",
  "channels",
  "skills",
  "mcp",
  "memory",
];

const DEFAULT_SETTINGS_SECTION: SettingsSection = "general";

const APPEARANCES: { id: Appearance; label: string; Icon: typeof SunIcon }[] = [
  { id: "light", label: "浅色", Icon: SunIcon },
  { id: "dark", label: "深色", Icon: MoonIcon },
  { id: "system", label: "跟随系统", Icon: MonitorIcon },
];

export interface SettingsPageHostState {
  isOpen: boolean;
  section: SettingsSection;
  open(section?: SettingsSection): void;
  openSection(section: SettingsSection): void;
  close(): void;
}

export function isSettingsSection(value: unknown): value is SettingsSection {
  return typeof value === "string" && SETTINGS_SECTIONS.includes(value as SettingsSection);
}

export function loadSettingsSection(): SettingsSection {
  try {
    const value = localStorage.getItem(SETTINGS_SEC_KEY);
    return isSettingsSection(value) ? value : DEFAULT_SETTINGS_SECTION;
  } catch {
    return DEFAULT_SETTINGS_SECTION;
  }
}

export function saveSettingsSection(section: SettingsSection): void {
  try {
    localStorage.setItem(SETTINGS_SEC_KEY, section);
  } catch {
    /* ignore */
  }
}

export function useSettingsPageHost(): SettingsPageHostState {
  const [isOpen, setIsOpen] = useState(false);
  const [section, setSection] = useState<SettingsSection>(loadSettingsSection);

  const open = useCallback((next?: SettingsSection) => {
    if (next) setSection(next);
    setIsOpen(true);
  }, []);

  const openSection = useCallback((next: SettingsSection) => {
    setSection(next);
    setIsOpen(true);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
  }, []);

  useEffect(() => {
    saveSettingsSection(section);
  }, [section]);

  useEffect(() => {
    const openFromEvent = ((ev?: Event) => {
      const detail = (ev as CustomEvent<unknown> | undefined)?.detail;
      open(isSettingsSection(detail) ? detail : undefined);
    }) as EventListener;
    window.addEventListener("ew:open-settings", openFromEvent);
    return () => window.removeEventListener("ew:open-settings", openFromEvent);
  }, [open]);

  return { isOpen, section, open, openSection, close };
}

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

function GeneralSettingsPane({
  theme,
  onThemeChange,
}: {
  theme: ThemePrefs;
  onThemeChange: (next: ThemePrefs) => void;
}) {
  return (
    <div className="set-group">
      <div className="set-row">
        <div className="set-row-info">
          <div className="set-row-title">界面主题</div>
          <div className="set-row-desc">切换应用界面使用的主题外观。</div>
        </div>
        <AppearanceSelect value={theme.appearance} onChange={(appearance) => onThemeChange({ ...theme, appearance })} />
      </div>
    </div>
  );
}

function buildSettingsSections({
  theme,
  onThemeChange,
  onModelsChange,
  activeSection,
}: Pick<SettingsPageHostProps, "theme" | "onThemeChange" | "onModelsChange"> & { activeSection: SettingsSection }): SettingsSectionDefinition[] {
  return [
    {
      id: "general",
      label: "通用",
      Icon: PaletteIcon,
      kind: "card",
      render: () => <GeneralSettingsPane theme={theme} onThemeChange={onThemeChange} />,
    },
    {
      id: "models",
      label: "模型",
      Icon: BoxIcon,
      kind: "page",
      keepAlive: true,
      render: () => <Models onChange={onModelsChange} />,
    },
    {
      id: "channels",
      label: "渠道",
      Icon: GitGraphIcon,
      kind: "page",
      keepAlive: true,
      render: () => <Channels />,
    },
    {
      id: "skills",
      label: "Skills",
      Icon: SparkIcon,
      kind: "page",
      keepAlive: true,
      render: () => <Skills active={activeSection === "skills"} />,
    },
    {
      id: "mcp",
      label: "MCP",
      Icon: PluginsIcon,
      kind: "page",
      keepAlive: true,
      render: () => <Mcp />,
    },
    {
      id: "memory",
      label: "记忆",
      Icon: BrainIcon,
      kind: "page",
      keepAlive: true,
      render: () => <MemoryOverlay embedded />,
    },
  ];
}

export function SettingsPageHost({
  theme,
  navWidth,
  section,
  onSectionChange,
  onThemeChange,
  onBack,
  onModelsChange,
  skillAttention,
}: SettingsPageHostProps) {
  const sections = useMemo(
    () => buildSettingsSections({ theme, onThemeChange, onModelsChange, activeSection: section }),
    [theme, onThemeChange, onModelsChange, section],
  );
  const sectionById = useMemo(() => new Map(sections.map((item) => [item.id, item])), [sections]);
  const current = sectionById.get(section) ?? sectionById.get(DEFAULT_SETTINGS_SECTION)!;
  const [visited, setVisited] = useState<Set<SettingsSection>>(() => new Set<SettingsSection>([current.id]));

  useEffect(() => {
    setVisited((value) => (value.has(current.id) ? value : new Set(value).add(current.id)));
  }, [current.id]);

  const openSection = (id: SettingsSection) => {
    setVisited((value) => (value.has(id) ? value : new Set(value).add(id)));
    onSectionChange(id);
  };

  return (
    <div className="set-page" data-testid="settings-page">
      <div className="set-nav" style={navWidth ? { width: navWidth } : undefined} data-tauri-drag-region>
        <button className="set-back" data-testid="settings-back" onClick={onBack}>
          <ArrowLeftIcon size={15} /> 返回工作区
        </button>
        {sections.map(({ id, label, Icon }) => (
          <button
            key={id}
            className={`set-navi ${current.id === id ? "on" : ""}`}
            data-testid={`settings-nav-${id}`}
            data-active={current.id === id ? "1" : "0"}
            onClick={() => openSection(id)}
          >
            <Icon size={16} /> {label}
            {id === "skills" && <SkillAttentionBadge attention={skillAttention} testId="settings-skill-attention" />}
          </button>
        ))}
      </div>

      <div className="set-main">
        <div className="set-phead">
          <h1 className="set-title" data-testid="settings-title">{current.label}</h1>
        </div>
        <div className="set-mbody">
          {sections.map((item) => {
            const active = current.id === item.id;
            const shouldRender = item.keepAlive ? visited.has(item.id) : active;
            if (!shouldRender) return null;
            if (item.kind === "card") {
              return (
                <div key={item.id} className={`set-content ${active ? "" : "hidden"}`} data-testid={`settings-pane-${item.id}`}>
                  {item.render()}
                </div>
              );
            }
            return (
              <div key={item.id} className={`set-pane ${active ? "" : "hidden"}`} data-testid={`settings-pane-${item.id}`}>
                {item.render()}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
