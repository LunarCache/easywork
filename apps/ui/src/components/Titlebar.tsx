import type { ThemePrefs, Accent, Appearance } from "../lib/prefs.js";
import { GearIcon, SunIcon, MoonIcon, MonitorIcon, GitBranchIcon } from "../icons.js";

const ACCENTS: { id: Accent; label: string; color: string }[] = [
  { id: "iris", label: "靛蓝", color: "#5256E0" },
  { id: "teal", label: "青绿", color: "#0F857A" },
  { id: "amber", label: "琥珀", color: "#B5640A" },
];

const APPEARANCE_ICON = { light: SunIcon, dark: MoonIcon, system: MonitorIcon } as const;
const NEXT_APPEARANCE: Record<Appearance, Appearance> = { light: "dark", dark: "system", system: "light" };

/** Agent Desk 顶部标题栏：交通灯点 + 品牌 + [work]分支 + accent 三点 + 密度/主题/设置。 */
export function Titlebar({
  theme,
  onThemeChange,
  onOpenSettings,
  branch,
}: {
  theme: ThemePrefs;
  onThemeChange: (next: ThemePrefs) => void;
  onOpenSettings: () => void;
  branch?: string;
}) {
  const AppIcon = APPEARANCE_ICON[theme.appearance];
  return (
    <div className="ad-titlebar" data-tauri-drag-region>
      <span className="ad-tb-brand">
        Easy<b>Work</b>
      </span>
      {branch && (
        <span className="ad-branch" title={branch}>
          <GitBranchIcon size={11} /> {branch}
        </span>
      )}
      <span className="ad-spacer" />
      <div className="ad-accents">
        {ACCENTS.map((a) => (
          <button
            key={a.id}
            className={`ad-acc-dot ${theme.accent === a.id ? "on" : ""}`}
            style={{ background: a.color }}
            title={a.label}
            aria-label={a.label}
            onClick={() => onThemeChange({ ...theme, accent: a.id })}
          />
        ))}
      </div>
      <span className="ad-tb-sep" />
      <button
        className="ad-tb-btn"
        title={`主题：${theme.appearance === "light" ? "浅色" : theme.appearance === "dark" ? "深色" : "跟随系统"}`}
        onClick={() => onThemeChange({ ...theme, appearance: NEXT_APPEARANCE[theme.appearance] })}
      >
        <AppIcon size={15} />
      </button>
      <button className="ad-tb-btn" title="设置" onClick={onOpenSettings}>
        <GearIcon size={15} />
      </button>
    </div>
  );
}
