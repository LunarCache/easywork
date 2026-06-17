import { useCallback, useEffect, useState } from "react";
import type { GGUFVariant, HFModelSummary, LocalModel } from "@ew/shared";
import type { ProviderInfo } from "@ew/sdk";
import { getClient } from "../lib/client.js";
import { BoxIcon, CheckIcon, ChevronIcon, DownloadIcon, GlobeIcon, SearchIcon, TrashIcon } from "../icons.js";

type ModelsTab = "local" | "cloud";

// 常见 OpenAI 兼容云端预设（点一下自动填 id + baseUrl）。
const PROVIDER_PRESETS: { id: string; label: string; baseUrl: string }[] = [
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1" },
  { id: "siliconflow", label: "硅基流动", baseUrl: "https://api.siliconflow.cn/v1" },
];

function fmtSize(bytes: number): string {
  const mb = bytes / 1e6;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

function fmtCtx(n?: number): string {
  if (!n) return "—";
  return n >= 1024 ? `${Math.round(n / 1024)}K` : String(n);
}

type ModelKind = "text" | "embed" | "vision";
const KIND_LABEL: Record<ModelKind, string> = { text: "文本", embed: "嵌入", vision: "多模态" };

/** 推断模型类型：视觉 → 多模态；arch/名称含 embed/bert/bge/… → 嵌入；否则文本。 */
function modelKind(m: LocalModel): ModelKind {
  if (m.hasVision) return "vision";
  const s = `${m.arch ?? ""} ${m.fileName} ${m.repoId ?? ""}`.toLowerCase();
  if (/embed|bert|bge|gte|e5|nomic|minilm/.test(s)) return "embed";
  return "text";
}

const QUANT_RE = /(IQ\d+_?[A-Z]*|Q\d+(?:_[A-Z0-9]+)*|BF16|F16|F32)/i;

/** 量化精度：优先用后端字段，否则从文件名推断（GGUF 命名约定）。 */
function quantOf(m: LocalModel): string | null {
  if (m.quant) return m.quant;
  const hit = m.fileName.replace(/\.gguf$/i, "").match(QUANT_RE);
  return hit?.[1] ? hit[1].toUpperCase() : null;
}

/** 清理展示名：去掉 .gguf 与结尾的量化后缀。 */
function displayName(m: LocalModel, quant: string | null): string {
  let name = m.fileName.replace(/\.gguf$/i, "");
  if (quant) name = name.replace(new RegExp(`[-._]?${quant}$`, "i"), "");
  return name;
}

export function Models({ onChange }: { onChange: () => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<HFModelSummary[]>([]);
  const [searched, setSearched] = useState(false);
  const [variants, setVariants] = useState<Record<string, GGUFVariant[]>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [local, setLocal] = useState<LocalModel[]>([]);
  const [loaded, setLoaded] = useState<string[]>([]);
  const [progress, setProgress] = useState<string>("");
  const [pct, setPct] = useState<number | null>(null);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  // 子页切换 + 云端 provider 状态
  const [tab, setTab] = useState<ModelsTab>("local");
  const [prov, setProv] = useState({ id: "", baseUrl: "", apiKey: "", models: "" });
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [provNote, setProvNote] = useState("");

  const refreshProviders = useCallback(async () => {
    try {
      setProviders(await getClient().listProviders());
    } catch {
      /* ignore */
    }
  }, []);

  const refreshLocal = useCallback(async () => {
    try {
      const [models, info] = await Promise.all([getClient().localModels(), getClient().listModels()]);
      setLocal(models);
      setLoaded(info.routed);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void refreshLocal();
  }, [refreshLocal]);

  // 云端 provider 仅在进入「云端 API」tab 时按需拉取（默认本地 tab 不浪费请求）。
  useEffect(() => {
    if (tab === "cloud") void refreshProviders();
  }, [tab, refreshProviders]);

  const addProvider = async () => {
    if (!prov.id.trim() || !prov.baseUrl.trim()) {
      setProvNote("请填写 id 与 baseUrl");
      return;
    }
    try {
      await getClient().addProvider({
        id: prov.id.trim(),
        baseUrl: prov.baseUrl.trim(),
        ...(prov.apiKey ? { apiKey: prov.apiKey } : {}),
        models: prov.models.split(",").map((s) => s.trim()).filter(Boolean),
      });
      setProvNote(`已添加 provider「${prov.id.trim()}」`);
      setProv({ id: "", baseUrl: "", apiKey: "", models: "" });
      await refreshProviders();
      onChange();
    } catch (e) {
      setProvNote(`添加失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const removeProvider = async (id: string) => {
    if (!confirm(`删除云端 provider「${id}」？其下的模型将不再可用。`)) return;
    try {
      await getClient().removeProvider(id);
      setProvNote(`已删除 provider「${id}」`);
      await refreshProviders();
      onChange();
    } catch (e) {
      setProvNote(`删除失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const search = async () => {
    if (!query.trim()) return;
    setSearching(true);
    setExpanded(null);
    try {
      setResults(await getClient().searchModels(query.trim()));
      setSearched(true);
    } finally {
      setSearching(false);
    }
  };

  const toggleVariants = async (repoId: string) => {
    if (expanded === repoId) {
      setExpanded(null);
      return;
    }
    setExpanded(repoId);
    if (!variants[repoId]) {
      const list = await getClient().listVariants(repoId);
      setVariants((m) => ({ ...m, [repoId]: list }));
    }
  };

  const download = async (v: GGUFVariant) => {
    setProgress(`开始下载 ${v.fileName}…`);
    setPct(0);
    try {
      for await (const ev of getClient().downloadModel(v)) {
        if (ev.type === "progress" && ev.totalBytes) {
          const p = Math.round((ev.receivedBytes / ev.totalBytes) * 100);
          setPct(p);
          setProgress(`下载 ${v.fileName} · ${p}% · ${(ev.bytesPerSec / 1e6).toFixed(1)} MB/s`);
        } else if (ev.type === "verifying") setProgress("校验中…");
        else if (ev.type === "done") {
          setProgress(`完成：${ev.model.fileName}`);
          setPct(null);
          await refreshLocal();
        } else if (ev.type === "error") {
          setProgress(`错误：${ev.message}`);
          setPct(null);
        }
      }
    } catch (e) {
      setProgress(`下载失败：${e instanceof Error ? e.message : String(e)}`);
      setPct(null);
    }
  };

  const load = async (m: LocalModel) => {
    setBusy(m.path);
    setProgress(`加载 ${m.fileName}…（首次启动 llama-server 需几秒）`);
    try {
      const contextSize = m.contextDefault ? Math.min(m.contextDefault, 8192) : 4096;
      await getClient().loadModel({ modelPath: m.path, contextSize, gpuLayers: 999 });
      setProgress(`已加载 ${m.fileName}`);
      await refreshLocal();
      onChange();
    } catch (e) {
      setProgress(`加载失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const unload = async (m: LocalModel) => {
    setBusy(m.path);
    try {
      await getClient().unloadModel(m.path);
      await refreshLocal();
      onChange();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page models">
      <div className="page-head">
        <span className="ico">
          <BoxIcon size={20} />
        </span>
        <div>
          <h2>模型</h2>
          <p className="lead">
            {tab === "local"
              ? "从 HuggingFace 搜索并下载 GGUF 到本地，或加载已下载的模型（经 llama-server 运行）。"
              : "接入 OpenAI / OpenRouter / DeepSeek 等 OpenAI 兼容云端端点，与本地模型一同在聊天中选用。"}
          </p>
        </div>
      </div>

      <div className="seg models-tabs">
        <button className={tab === "local" ? "on" : ""} onClick={() => setTab("local")}>
          <BoxIcon size={14} /> 本地模型
        </button>
        <button className={tab === "cloud" ? "on" : ""} onClick={() => setTab("cloud")}>
          <GlobeIcon size={14} /> 云端 API
        </button>
      </div>

      {tab === "cloud" ? (
        <CloudProviders
          prov={prov}
          setProv={setProv}
          providers={providers}
          note={provNote}
          onAdd={() => void addProvider()}
          onRemove={(id) => void removeProvider(id)}
        />
      ) : (
        <LocalModels
          query={query}
          setQuery={setQuery}
          search={() => void search()}
          searching={searching}
          progress={progress}
          pct={pct}
          searched={searched}
          results={results}
          expanded={expanded}
          variants={variants}
          toggleVariants={(id) => void toggleVariants(id)}
          download={(v) => void download(v)}
          closeSearch={() => {
            setSearched(false);
            setResults([]);
            setExpanded(null);
          }}
          local={local}
          loaded={loaded}
          busy={busy}
          load={(m) => void load(m)}
          unload={(m) => void unload(m)}
        />
      )}
    </div>
  );
}

/** 本地模型子页：HF 搜索/下载 + 已下载模型网格（加载/卸载）。 */
function LocalModels(props: {
  query: string;
  setQuery: (v: string) => void;
  search: () => void;
  searching: boolean;
  progress: string;
  pct: number | null;
  searched: boolean;
  results: HFModelSummary[];
  expanded: string | null;
  variants: Record<string, GGUFVariant[]>;
  toggleVariants: (repoId: string) => void;
  download: (v: GGUFVariant) => void;
  closeSearch: () => void;
  local: LocalModel[];
  loaded: string[];
  busy: string | null;
  load: (m: LocalModel) => void;
  unload: (m: LocalModel) => void;
}) {
  const {
    query, setQuery, search, searching, progress, pct, searched, results, expanded,
    variants, toggleVariants, download, closeSearch, local, loaded, busy, load, unload,
  } = props;
  return (
    <>
      <div className="row search-row">
        <div className="field">
          <SearchIcon size={16} />
          <input
            value={query}
            placeholder="搜索 HuggingFace GGUF 模型（如 qwen3 / llama）"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void search()}
          />
        </div>
        <button onClick={() => void search()} disabled={searching}>
          {searching ? "搜索中…" : "搜索"}
        </button>
      </div>

      {progress && (
        <div className="note">
          {progress}
          {pct != null && (
            <div className="progress">
              <div className="progress-fill" style={{ width: `${pct}%` }} />
            </div>
          )}
        </div>
      )}

      {searched && (
        <section className="search-panel">
          <div className="sp-head">
            <span>搜索结果 · {results.length}</span>
            <button className="sp-close" onClick={closeSearch}>
              收起
            </button>
          </div>
          {results.length === 0 && <div className="sub pad">没有找到匹配的 GGUF 模型，换个关键词试试。</div>}
          {results.map((r) => (
            <div key={r.repoId} className={`hf-result ${expanded === r.repoId ? "open" : ""}`}>
              <button className="hf-row" onClick={() => void toggleVariants(r.repoId)}>
                <ChevronIcon size={15} className="hf-chev" />
                <span className="hf-name">{r.repoId}</span>
                <span className="hf-meta">
                  ↓{r.downloads.toLocaleString()} · ♥{r.likes}
                </span>
              </button>
              {expanded === r.repoId && (
                <div className="hf-variants">
                  {!variants[r.repoId] && <div className="sub pad">加载变体…</div>}
                  {variants[r.repoId]?.length === 0 && <div className="sub pad">该仓库没有可用 GGUF 变体。</div>}
                  {variants[r.repoId]?.map((v) => (
                    <div key={v.fileName} className="hf-variant">
                      <span className="v-quant">{v.quant}</span>
                      <span className="v-size">
                        {fmtSize(v.sizeBytes)}
                        {v.shardCount > 1 ? ` · ${v.shardCount} 分片` : ""}
                      </span>
                      <button className="btn-sm" onClick={() => void download(v)}>
                        <DownloadIcon size={13} /> 下载
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </section>
      )}

      <section className="local-section">
        <div className="ls-head">
          <h3>本地模型</h3>
          <span className="ls-count">{local.length}</span>
        </div>
        {local.length === 0 ? (
          <div className="empty-models">
            <BoxIcon size={26} />
            <p>还没有本地模型</p>
            <span>在上方搜索并下载一个 GGUF 模型即可开始。</span>
          </div>
        ) : (
          <div className="model-grid">
            {local.map((m) => {
              const isLoaded = loaded.includes(m.path);
              const isBusy = busy === m.path;
              const kind = modelKind(m);
              const quant = quantOf(m);
              return (
                <div key={m.id} className={`model-card ${isLoaded ? "loaded" : ""}`}>
                  <span className={`mc-glyph k-${kind}`}>
                    <BoxIcon size={17} />
                  </span>
                  <div className="mc-body">
                    <div className="mc-name-row">
                      <span className="mc-name" title={m.fileName}>
                        {displayName(m, quant)}
                      </span>
                      <span className={`type-pill k-${kind}`}>{KIND_LABEL[kind]}</span>
                      {isLoaded && (
                        <span className="mc-badge live">
                          <span className="dot ok" /> 运行中
                        </span>
                      )}
                    </div>
                    <div className="mc-specline">
                      {(m.repoId ?? m.arch) && <span className="ms-repo">{m.repoId ?? m.arch}</span>}
                      <span>上下文 {fmtCtx(m.contextDefault)}</span>
                      {quant && <span>{quant}</span>}
                      <span>{fmtSize(m.sizeBytes)}</span>
                    </div>
                  </div>
                  {isLoaded ? (
                    <button className="btn-ghost mc-act" disabled={isBusy} onClick={() => void unload(m)}>
                      {isBusy ? "卸载中…" : "卸载"}
                    </button>
                  ) : (
                    <button className="mc-act" disabled={isBusy} onClick={() => void load(m)}>
                      {isBusy ? (
                        "加载中…"
                      ) : (
                        <>
                          <CheckIcon size={14} /> 加载
                        </>
                      )}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}

/** 云端 API 子页：OpenAI 兼容 provider 的添加 / 列表 / 删除。 */
function CloudProviders(props: {
  prov: { id: string; baseUrl: string; apiKey: string; models: string };
  setProv: (v: { id: string; baseUrl: string; apiKey: string; models: string }) => void;
  providers: ProviderInfo[];
  note: string;
  onAdd: () => void;
  onRemove: (id: string) => void;
}) {
  const { prov, setProv, providers, note, onAdd, onRemove } = props;
  return (
    <>
      {note && <div className="note">{note}</div>}

      <section>
        <div className="sec-head">
          <span className="ico blue">
            <GlobeIcon size={18} />
          </span>
          <div>
            <h3>添加云端 Provider</h3>
            <p className="hint">任意 OpenAI 兼容端点（/v1）。Key 持久化在本机 daemon。</p>
          </div>
        </div>
        <div className="prov-presets">
          {PROVIDER_PRESETS.map((p) => (
            <button
              key={p.id}
              className="prov-preset"
              title={p.baseUrl}
              onClick={() => setProv({ ...prov, id: prov.id || p.id, baseUrl: p.baseUrl })}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="form">
          <input placeholder="id（如 openrouter）" value={prov.id} onChange={(e) => setProv({ ...prov, id: e.target.value })} />
          <input placeholder="baseUrl（.../v1）" value={prov.baseUrl} onChange={(e) => setProv({ ...prov, baseUrl: e.target.value })} />
          <input placeholder="API Key" type="password" value={prov.apiKey} onChange={(e) => setProv({ ...prov, apiKey: e.target.value })} />
          <input placeholder="模型（逗号分隔）" value={prov.models} onChange={(e) => setProv({ ...prov, models: e.target.value })} />
          <button onClick={onAdd}>添加</button>
        </div>
      </section>

      <section className="local-section">
        <div className="ls-head">
          <h3>已配置 Provider</h3>
          <span className="ls-count">{providers.length}</span>
        </div>
        {providers.length === 0 ? (
          <div className="empty-models">
            <GlobeIcon size={26} />
            <p>还没有云端 Provider</p>
            <span>用上方表单接入一个 OpenAI 兼容端点即可在聊天中选用。</span>
          </div>
        ) : (
          providers.map((p) => (
            <div key={p.id} className="mcp-row">
              <span className="mc-glyph k-text">
                <GlobeIcon size={17} />
              </span>
              <div className="mcp-info">
                <div className="mcp-name">{p.id}</div>
                <div className="mcp-detail">{p.baseUrl}</div>
                {p.models.length > 0 && (
                  <div className="mcp-detail">{p.models.join("、")}</div>
                )}
              </div>
              <button className="mcp-del" title="删除" onClick={() => onRemove(p.id)}>
                <TrashIcon size={15} />
              </button>
            </div>
          ))
        )}
      </section>
    </>
  );
}
