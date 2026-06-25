import { useCallback, useEffect, useState } from "react";
import type { LocalNetInfo } from "@ew/sdk";
import { getClient } from "../lib/client.js";
import { type Appearance, type ThemePrefs } from "../lib/prefs.js";
import { Models } from "./Models.js";
import { Skills } from "./Skills.js";
import { Mcp } from "./Mcp.js";
import { KnowledgeBaseOverlay } from "../components/KnowledgeBaseOverlay.js";
import { MemoryOverlay } from "../components/MemoryOverlay.js";
import {
  PaletteIcon,
  AlertIcon,
  SunIcon,
  MoonIcon,
  MonitorIcon,
  ArrowLeftIcon,
  BoxIcon,
  BookIcon,
  SparkIcon,
  BrainIcon,
  PluginsIcon,
} from "../icons.js";

export type SettingsSection = "general" | "models" | "kb" | "skills" | "mcp" | "memory";


const APPEARANCES: { id: Appearance; label: string; Icon: typeof SunIcon }[] = [
  { id: "light", label: "浅色", Icon: SunIcon },
  { id: "dark", label: "深色", Icon: MoonIcon },
  { id: "system", label: "跟随系统", Icon: MonitorIcon },
];
/** 生成一个随机 api-key（暴露 0.0.0.0 时用）。 */
function genApiKey(): string {
  return "ew-" + crypto.randomUUID().replace(/-/g, "");
}

export function Settings({
  theme,
  navWidth,
  onThemeChange,
  onBack,
  onModelsChange,
}: {
  theme: ThemePrefs;
  /** 与主侧栏同宽，保证设置页的左栏分割线与默认页对齐。 */
  navWidth?: number;
  onThemeChange: (next: ThemePrefs) => void;
  onBack: () => void;
  onModelsChange: () => void;
}) {
  const [sec, setSec] = useState<SettingsSection>("general");
  // 已访问的「页」型分区保持挂载（CSS 隐藏非当前），避免切走丢状态（如知识库上传/索引轮询）。
  const [visited, setVisited] = useState<Set<SettingsSection>>(() => new Set<SettingsSection>(["general"]));
  const openSec = (id: SettingsSection) => {
    setVisited((v) => (v.has(id) ? v : new Set(v).add(id)));
    setSec(id);
  };
  const [note, setNote] = useState("");
  const [net, setNet] = useState<LocalNetInfo | null>(null);
  const [netBusy, setNetBusy] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState("");

  const refresh = useCallback(async () => {
    try {
      setNet(await getClient().getLocalNet());
    } catch {
      /* ignore */
    }
  }, []);

  const changeBind = async (host: "127.0.0.1" | "0.0.0.0") => {
    if (netBusy || net?.bindHost === host) return;
    let apiKey: string | undefined;
    if (host === "0.0.0.0") {
      // 暴露到局域网必须有 api-key：用输入框 / 现有 / 自动生成。
      apiKey = apiKeyInput.trim() || net?.apiKey || genApiKey();
    }
    setNetBusy(true);
    setNote(host === "0.0.0.0" ? "正在重载模型并暴露到局域网…" : "正在重载模型并收回到本机…");
    try {
      const r = await getClient().setLocalNet(host, apiKey);
      setNet(r);
      setApiKeyInput("");
      setNote(host === "0.0.0.0" ? "已暴露到局域网（0.0.0.0）" : "已收回到仅本机（127.0.0.1）");
    } catch (e) {
      setNote(`切换失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setNetBusy(false);
    }
  };

  /** 端点对外可用 URL：绑 0.0.0.0 时其他设备用本机局域网 IP。 */
  const endpointUrl = (port: number): string => {
    const host = net?.bindHost === "0.0.0.0" ? net?.lanIp ?? "0.0.0.0" : "127.0.0.1";
    return `http://${host}:${port}/v1`;
  };

  useEffect(() => {
    void refresh();
  }, [refresh]);

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

  return (
    <div className="set-page">
      <div className="set-nav" style={navWidth ? { width: navWidth } : undefined}>
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
        {CARD_SECS.has(sec) && (
          <div className="set-content">
            <h1 className="set-title">{SECS.find((s) => s.id === sec)?.label}</h1>
            {note && <div className="note">{note}</div>}

            {sec === "general" && (
              <div className="set-group">
                <div className="set-row">
              <div className="set-row-info">
                <div className="set-row-title">明暗模式</div>
                <div className="set-row-desc">选择应用界面主题。</div>
              </div>
              <div className="seg">
                {APPEARANCES.map(({ id, label, Icon }) => (
                  <button
                    key={id}
                    className={theme.appearance === id ? "on" : ""}
                    onClick={() => onThemeChange({ ...theme, appearance: id })}
                  >
                    <Icon size={14} style={{ marginRight: 5, verticalAlign: "-2px" }} />
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {sec === "general" && (
          <>
            <div className="set-group">
              <div className="set-row">
                <div className="set-row-info">
                  <div className="set-row-title">网络访问</div>
                  <div className="set-row-desc">仅本机，或暴露到局域网供其它设备直连（0.0.0.0 须 api-key）。</div>
                </div>
                <div className="seg">
                  <button className={net?.bindHost !== "0.0.0.0" ? "on" : ""} disabled={netBusy} onClick={() => void changeBind("127.0.0.1")}>
                    仅本机
                  </button>
                  <button className={net?.bindHost === "0.0.0.0" ? "on" : ""} disabled={netBusy} onClick={() => void changeBind("0.0.0.0")}>
                    局域网
                  </button>
                </div>
              </div>
              <div className="set-row">
                <div className="set-row-info">
                  <div className="set-row-title">API Key</div>
                  <div className="set-row-desc">绑定 0.0.0.0 时必填；留空自动生成。</div>
                </div>
                <div className="set-row-control">
                  <input
                    className="set-key-input"
                    placeholder="api-key"
                    type="text"
                    value={apiKeyInput}
                    onChange={(e) => setApiKeyInput(e.target.value)}
                  />
                  <button className="set-add" disabled={netBusy} onClick={() => setApiKeyInput(genApiKey())}>
                    生成
                  </button>
                </div>
              </div>
            </div>
            {net?.bindHost === "0.0.0.0" && (
              <div className="note">
                <AlertIcon size={14} style={{ verticalAlign: "-2px", marginRight: 5 }} />
                已绑定 0.0.0.0：局域网设备需带 <code>Authorization: Bearer {net.apiKey}</code> 才能访问。请仅在可信网络使用。
              </div>
            )}
            {net && net.endpoints.length > 0 && (
              <div className="set-group">
                <div className="set-row col">
                  <div className="set-row-title">已加载模型端点（外部可直连）</div>
                  {net.endpoints.map((ep) => (
                    <div key={ep.id} className="sub mono">
                      {ep.id.split("/").pop()} → {endpointUrl(ep.port)}
                    </div>
                  ))}
                </div>
              </div>
            )}
              </>
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
  );
}
