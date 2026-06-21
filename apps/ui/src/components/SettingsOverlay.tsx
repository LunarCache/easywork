import { Models } from "../pages/Models.js";
import { KnowledgeBase } from "../pages/KnowledgeBase.js";
import { Skills } from "../pages/Skills.js";
import { Mcp } from "../pages/Mcp.js";
import { Settings } from "../pages/Settings.js";
import type { ThemePrefs } from "../lib/prefs.js";
import { BoxIcon, KbIcon, SparkIcon, WrenchIcon, GearIcon, XIcon } from "../icons.js";

export type SettingsTab = "models" | "kb" | "skills" | "mcp" | "general";

const NAV: { id: SettingsTab; label: string; Icon: typeof BoxIcon }[] = [
  { id: "models", label: "模型", Icon: BoxIcon },
  { id: "kb", label: "知识库", Icon: KbIcon },
  { id: "skills", label: "Skills", Icon: SparkIcon },
  { id: "mcp", label: "MCP", Icon: WrenchIcon },
  { id: "general", label: "通用", Icon: GearIcon },
];

/** Agent Desk 设置浮层：左导航(模型/知识库/Skills/MCP/通用) + 右内容（复用既有页面）。 */
export function SettingsOverlay({
  tab,
  setTab,
  onClose,
  onModelsChange,
  theme,
  onThemeChange,
}: {
  tab: SettingsTab;
  setTab: (t: SettingsTab) => void;
  onClose: () => void;
  onModelsChange: () => void;
  theme: ThemePrefs;
  onThemeChange: (next: ThemePrefs) => void;
}) {
  return (
    <div className="ad-overlay" onClick={onClose}>
      <div className="ad-overlay-card" onClick={(e) => e.stopPropagation()}>
        <div className="ad-ov-head">
          <span className="ad-ov-title">设置</span>
          <span className="ad-spacer" />
          <button className="ad-ov-close" title="关闭" onClick={onClose}>
            <XIcon size={15} />
          </button>
        </div>
        <div className="ad-ov-body">
          <div className="ad-ov-nav">
            {NAV.map(({ id, label, Icon }) => (
              <button key={id} className={`ad-ov-nav-btn ${tab === id ? "on" : ""}`} onClick={() => setTab(id)}>
                <Icon size={16} />
                <span>{label}</span>
              </button>
            ))}
          </div>
          <div className="ad-ov-content">
            {tab === "models" && <Models onChange={onModelsChange} />}
            {tab === "kb" && <KnowledgeBase />}
            {tab === "skills" && <Skills />}
            {tab === "mcp" && <Mcp />}
            {tab === "general" && <Settings theme={theme} onThemeChange={onThemeChange} />}
          </div>
        </div>
      </div>
    </div>
  );
}
