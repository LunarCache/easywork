import { useCallback, useEffect, useState } from "react";
import { getClient } from "../lib/client.js";
import { loadAgentPrefs, saveAgentPrefs, type AgentPrefs } from "../lib/prefs.js";
import { SlidersIcon, BoxIcon, BrainIcon } from "../icons.js";

export function Settings({ onChange }: { onChange: () => void }) {
  const [prov, setProv] = useState({ id: "", baseUrl: "", apiKey: "", models: "" });
  const [providers, setProviders] = useState<{ id: string; baseUrl: string; models: string[] }[]>([]);
  const [note, setNote] = useState("");
  const [agentPrefs, setAgentPrefs] = useState<AgentPrefs>(() => loadAgentPrefs());

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
  }, []);

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
    </div>
  );
}
