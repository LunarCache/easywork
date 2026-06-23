import { useCallback, useEffect, useState } from "react";
import type { LocalNetInfo } from "@ew/sdk";
import { getClient } from "../lib/client.js";
import {
  loadAgentPrefs,
  saveAgentPrefs,
  type AgentPrefs,
  type Appearance,
  type Accent,
  type ThemePrefs,
} from "../lib/prefs.js";
import { SlidersIcon, BrainIcon, GlobeIcon, SunIcon, MoonIcon, MonitorIcon, PaletteIcon, AlertIcon } from "../icons.js";

const APPEARANCES: { id: Appearance; label: string; Icon: typeof SunIcon }[] = [
  { id: "light", label: "浅色", Icon: SunIcon },
  { id: "dark", label: "深色", Icon: MoonIcon },
  { id: "system", label: "跟随系统", Icon: MonitorIcon },
];
const ACCENTS: { id: Accent; label: string; color: string }[] = [
  { id: "iris", label: "靛蓝", color: "#5256E0" },
  { id: "teal", label: "青绿", color: "#0F857A" },
  { id: "amber", label: "琥珀", color: "#B5640A" },
];
/** 生成一个随机 api-key（暴露 0.0.0.0 时用）。 */
function genApiKey(): string {
  return "ew-" + crypto.randomUUID().replace(/-/g, "");
}

export function Settings({
  theme,
  onThemeChange,
}: {
  theme: ThemePrefs;
  onThemeChange: (next: ThemePrefs) => void;
}) {
  const [note, setNote] = useState("");
  const [agentPrefs, setAgentPrefs] = useState<AgentPrefs>(() => loadAgentPrefs());
  const [net, setNet] = useState<LocalNetInfo | null>(null);
  const [netBusy, setNetBusy] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState("");

  const setAgentPref = (key: keyof AgentPrefs, raw: string) => {
    const v = raw.trim() === "" ? undefined : Number(raw);
    const next = { ...agentPrefs, [key]: v };
    if (v === undefined || Number.isNaN(v)) delete next[key];
    setAgentPrefs(next);
    saveAgentPrefs(next);
  };

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

  return (
    <div className="page">
      <div className="page-head">
        <span className="ico">
          <SlidersIcon size={20} />
        </span>
        <div>
          <h2>设置</h2>
        </div>
      </div>
      {note && <div className="note">{note}</div>}

      <section>
        <div className="sec-head">
          <span className="ico blue">
            <PaletteIcon size={18} />
          </span>
          <div>
            <h3>外观</h3>
          </div>
        </div>
        <div className="appearance-row">
          <div className="appearance-block">
            <span>明暗模式</span>
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
          <div className="appearance-block">
            <span>主题色</span>
            <div className="swatches">
              {ACCENTS.map(({ id, label, color }) => (
                <button
                  key={id}
                  className={`swatch ${theme.accent === id ? "on" : ""}`}
                  style={{ background: color }}
                  title={label}
                  aria-label={label}
                  onClick={() => onThemeChange({ ...theme, accent: id })}
                />
              ))}
            </div>
          </div>
        </div>
      </section>

      <section>
        <div className="sec-head">
          <span className="ico violet">
            <BrainIcon size={18} />
          </span>
          <div>
            <h3>Agent 循环</h3>
          </div>
        </div>
        <div className="params-grid">
          <label>
            <span>最大工具迭代轮数</span>
            <input type="number" step="1" min="1" max="100" placeholder="默认 25" value={agentPrefs.maxIterations ?? ""} onChange={(e) => setAgentPref("maxIterations", e.target.value)} />
          </label>
        </div>
      </section>

      <section>
        <div className="sec-head">
          <span className="ico">
            <GlobeIcon size={18} />
          </span>
          <div>
            <h3>本地网络</h3>
          </div>
        </div>
        <div className="seg">
          <button
            className={net?.bindHost !== "0.0.0.0" ? "on" : ""}
            disabled={netBusy}
            onClick={() => void changeBind("127.0.0.1")}
          >
            仅本机（127.0.0.1）
          </button>
          <button
            className={net?.bindHost === "0.0.0.0" ? "on" : ""}
            disabled={netBusy}
            onClick={() => void changeBind("0.0.0.0")}
          >
            局域网（0.0.0.0）
          </button>
        </div>
        <div className="form" style={{ marginTop: 8 }}>
          <input
            placeholder="api-key（绑 0.0.0.0 必填；留空自动生成）"
            type="text"
            value={apiKeyInput}
            onChange={(e) => setApiKeyInput(e.target.value)}
          />
          <button disabled={netBusy} onClick={() => setApiKeyInput(genApiKey())}>
            生成
          </button>
        </div>
        {net?.bindHost === "0.0.0.0" && (
          <div className="note">
            <AlertIcon size={14} style={{ verticalAlign: "-2px", marginRight: 5 }} />
            已绑定 0.0.0.0：局域网设备需带 <code>Authorization: Bearer {net.apiKey}</code> 才能访问。请仅在可信网络使用。
          </div>
        )}
        {net && net.endpoints.length > 0 ? (
          <div className="form-col">
            <p className="hint">已加载模型端点（外部可直连）：</p>
            {net.endpoints.map((ep) => (
              <div key={ep.id} className="sub mono">
                {ep.id.split("/").pop()} → {endpointUrl(ep.port)}
              </div>
            ))}
          </div>
        ) : (
          <p className="hint">（暂无已加载的本地模型）</p>
        )}
      </section>
    </div>
  );
}
