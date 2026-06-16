import { useCallback, useEffect, useState } from "react";
import type { LocalNetInfo } from "@ew/sdk";
import { getClient } from "../lib/client.js";
import {
  loadAgentPrefs,
  saveAgentPrefs,
  type AgentPrefs,
  type Appearance,
  type ColorTheme,
  type ThemePrefs,
} from "../lib/prefs.js";
import { SlidersIcon, BoxIcon, BrainIcon, GlobeIcon, SunIcon, MoonIcon, MonitorIcon, PaletteIcon } from "../icons.js";

const APPEARANCES: { id: Appearance; label: string; Icon: typeof SunIcon }[] = [
  { id: "light", label: "浅色", Icon: SunIcon },
  { id: "dark", label: "深色", Icon: MoonIcon },
  { id: "system", label: "跟随系统", Icon: MonitorIcon },
];
const COLOR_THEMES: { id: ColorTheme; label: string; color: string }[] = [
  { id: "black", label: "黑", color: "#333333" },
  { id: "blue", label: "蓝", color: "#4E80F7" },
  { id: "purple", label: "紫", color: "#9169BF" },
  { id: "green", label: "绿", color: "#57A64B" },
];

/** 生成一个随机 api-key（暴露 0.0.0.0 时用）。 */
function genApiKey(): string {
  return "ew-" + crypto.randomUUID().replace(/-/g, "");
}

export function Settings({
  onChange,
  theme,
  onThemeChange,
}: {
  onChange: () => void;
  theme: ThemePrefs;
  onThemeChange: (next: ThemePrefs) => void;
}) {
  const [prov, setProv] = useState({ id: "", baseUrl: "", apiKey: "", models: "" });
  const [providers, setProviders] = useState<{ id: string; baseUrl: string; models: string[] }[]>([]);
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
      setProviders(await getClient().listProviders());
    } catch {
      /* ignore */
    }
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

  const addProvider = async () => {
    if (!prov.id || !prov.baseUrl) return;
    await getClient().addProvider({
      id: prov.id,
      baseUrl: prov.baseUrl,
      ...(prov.apiKey ? { apiKey: prov.apiKey } : {}),
      models: prov.models.split(",").map((s) => s.trim()).filter(Boolean),
    });
    setNote(`已添加 provider ${prov.id}`);
    setProv({ id: "", baseUrl: "", apiKey: "", models: "" });
    await refresh();
    onChange();
  };

  return (
    <div className="page">
      <div className="page-head">
        <span className="ico">
          <SlidersIcon size={20} />
        </span>
        <div>
          <h2>设置</h2>
          <p className="lead">云端 Provider 与 Agent 循环。模型 / 知识库 / Skills / MCP / 记忆 已各成独立页面。</p>
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
            <p className="hint">明暗模式与主题色（仅影响本机界面，立即生效）</p>
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
              {COLOR_THEMES.map(({ id, label, color }) => (
                <button
                  key={id}
                  className={`swatch ${theme.colorTheme === id ? "on" : ""}`}
                  style={{ background: color }}
                  title={label}
                  aria-label={label}
                  onClick={() => onThemeChange({ ...theme, colorTheme: id })}
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
            <p className="hint">工具调用循环的安全上限。（采样参数在聊天界面按模型设置）</p>
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
          <span className="ico blue">
            <BoxIcon size={18} />
          </span>
          <div>
            <h3>云端 Provider（OpenAI 兼容）</h3>
            <p className="hint">接 OpenAI / OpenRouter / vLLM 等兼容端点</p>
          </div>
        </div>
        <div className="form">
          <input placeholder="id (如 openrouter)" value={prov.id} onChange={(e) => setProv({ ...prov, id: e.target.value })} />
          <input placeholder="baseUrl (.../v1)" value={prov.baseUrl} onChange={(e) => setProv({ ...prov, baseUrl: e.target.value })} />
          <input placeholder="API Key" type="password" value={prov.apiKey} onChange={(e) => setProv({ ...prov, apiKey: e.target.value })} />
          <input placeholder="模型(逗号分隔)" value={prov.models} onChange={(e) => setProv({ ...prov, models: e.target.value })} />
          <button onClick={() => void addProvider()}>添加</button>
        </div>
        {providers.map((p) => (
          <div key={p.id} className="sub">
            {p.id} → {p.baseUrl} [{p.models.join(", ")}]
          </div>
        ))}
      </section>

      <section>
        <div className="sec-head">
          <span className="ico">
            <GlobeIcon size={18} />
          </span>
          <div>
            <h3>本地网络（暴露 llama-server）</h3>
            <p className="hint">本地模型经 /v1 由本进程提供；也可让 llama-server 端口被本机/局域网其他服务直接调用。</p>
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
            ⚠️ 已绑定 0.0.0.0：局域网设备需带 <code>Authorization: Bearer {net.apiKey}</code> 才能访问。请仅在可信网络使用。
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
