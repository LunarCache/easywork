import { useCallback, useEffect, useState } from "react";
import type { LocalNetInfo } from "@ew/sdk";
import { getClient } from "../lib/client.js";
import { type Appearance, type ThemePrefs } from "../lib/prefs.js";
import {
  SlidersIcon,
  GlobeIcon,
  PaletteIcon,
  AlertIcon,
  KbIcon,
  SunIcon,
  MoonIcon,
  MonitorIcon,
} from "../icons.js";

type EmbedStatus = { ready: boolean; modelId?: string; dim: number };

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
  onThemeChange,
}: {
  theme: ThemePrefs;
  onThemeChange: (next: ThemePrefs) => void;
}) {
  const [note, setNote] = useState("");
  const [net, setNet] = useState<LocalNetInfo | null>(null);
  const [netBusy, setNetBusy] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [embed, setEmbed] = useState<EmbedStatus | null>(null);
  const [embedBusy, setEmbedBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setNet(await getClient().getLocalNet());
    } catch {
      /* ignore */
    }
    try {
      setEmbed(await getClient().embeddingStatus());
    } catch {
      /* ignore */
    }
  }, []);

  const enableEmbed = async () => {
    if (embedBusy) return;
    setEmbedBusy(true);
    setNote("正在启用向量记忆：下载嵌入模型 + 重建索引，可能耗时…");
    try {
      const r = await getClient().enableEmbedding();
      setEmbed(r);
      setNote(`向量记忆已启用：${r.dim} 维（重建索引 ${r.reindexed} 条）`);
    } catch (e) {
      setNote(`启用失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setEmbedBusy(false);
    }
  };

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
        </div>
      </section>

      <section>
        <div className="sec-head">
          <span className="ico violet">
            <KbIcon size={18} />
          </span>
          <div>
            <h3>向量记忆</h3>
          </div>
        </div>
        {embed?.ready ? (
          <div className="form-col">
            <div className="sub">
              <span className="mcp-dot ok" style={{ verticalAlign: "0px", marginRight: 6 }} />
              已启用 · <code>{embed.modelId?.split("/").pop() ?? "嵌入模型"}</code> · {embed.dim} 维
            </div>
            <p className="hint">记忆与知识库走 sqlite-vec 语义 ⊕ 词法混合召回。可在「模型」页管理嵌入模型。</p>
          </div>
        ) : (
          <div className="form-col">
            <p className="hint">
              未启用：记忆与知识库当前仅用词法（关键词）召回。启用将下载本地 CPU 嵌入模型（nomic-embed，约 80MB）并重建索引。
            </p>
            <button className="set-add primary" disabled={embedBusy} onClick={() => void enableEmbed()}>
              {embedBusy ? "启用中…（下载 + 重建索引）" : "启用向量记忆"}
            </button>
          </div>
        )}
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
