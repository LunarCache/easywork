import { useCallback, useEffect, useState } from "react";
import type { GGUFVariant, HFModelSummary, LocalModel } from "@ew/shared";
import type { ProviderInfo } from "@ew/sdk";
import { getClient } from "../lib/client.js";
import {
  AlertIcon,
  BoxIcon,
  ChevronIcon,
  DownloadIcon,
  GlobeIcon,
  SearchIcon,
  TrashIcon,
  PlusIcon,
  ArrowLeftIcon,
} from "../icons.js";

type ModelsTab = "local" | "cloud";
type View = "list" | "search" | "add-provider";

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
function modelKind(m: LocalModel): ModelKind {
  if (m.hasVision) return "vision";
  const s = `${m.arch ?? ""} ${m.fileName} ${m.repoId ?? ""}`.toLowerCase();
  if (/embed|bert|bge|gte|e5|nomic|minilm/.test(s)) return "embed";
  return "text";
}
const QUANT_RE = /(IQ\d+_?[A-Z]*|Q\d+(?:_[A-Z0-9]+)*|BF16|F16|F32)/i;
function quantOf(m: LocalModel): string | null {
  if (m.quant) return m.quant;
  const hit = m.fileName.replace(/\.gguf$/i, "").match(QUANT_RE);
  return hit?.[1] ? hit[1].toUpperCase() : null;
}
function displayName(m: LocalModel, quant: string | null): string {
  let name = m.fileName.replace(/\.gguf$/i, "");
  if (quant) name = name.replace(new RegExp(`[-._]?${quant}$`, "i"), "");
  return name;
}

export function Models({ onChange }: { onChange: () => void }) {
  const [tab, setTabRaw] = useState<ModelsTab>("local");
  const [view, setView] = useState<View>("list");
  const setTab = (t: ModelsTab) => {
    setTabRaw(t);
    setView("list");
  };

  // 本地搜索/下载
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<HFModelSummary[]>([]);
  const [searched, setSearched] = useState(false);
  const [variants, setVariants] = useState<Record<string, GGUFVariant[]>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [progress, setProgress] = useState("");
  const [pct, setPct] = useState<number | null>(null);

  // 本地模型
  const [local, setLocal] = useState<LocalModel[]>([]);
  const [loaded, setLoaded] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  // 嵌入（向量记忆）模型独立进程，状态与 router 分离。
  const [embed, setEmbed] = useState<{ ready: boolean; modelId?: string; dim: number } | null>(null);
  const [embedBusy, setEmbedBusy] = useState(false);

  // 运行时
  const [runtime, setRuntime] = useState<{ found: boolean; path?: string; kind?: string; install: string } | null>(null);
  const [rtInstalling, setRtInstalling] = useState(false);

  // 云端 provider
  const [prov, setProv] = useState({ id: "", baseUrl: "", apiKey: "", models: "", context: "" });
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [provNote, setProvNote] = useState("");

  const refreshLocal = useCallback(async () => {
    try {
      const [models, info, emb] = await Promise.all([
        getClient().localModels(),
        getClient().listModels(),
        getClient().embeddingStatus().catch(() => null),
      ]);
      setLocal(models);
      setLoaded(info.routed);
      setEmbed(emb);
    } catch {
      /* ignore */
    }
  }, []);
  const refreshRuntime = useCallback(async () => {
    try {
      setRuntime(await getClient().runtimeStatus());
    } catch {
      /* ignore */
    }
  }, []);
  const refreshProviders = useCallback(async () => {
    try {
      setProviders(await getClient().listProviders());
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void refreshLocal();
    void refreshRuntime();
  }, [refreshLocal, refreshRuntime]);
  useEffect(() => {
    if (tab === "cloud") void refreshProviders();
  }, [tab, refreshProviders]);

  const installRuntime = async () => {
    setRtInstalling(true);
    setProgress("正在经 llama.app 安装本地推理运行时…（首次需下载，约几十秒）");
    try {
      const r = await getClient().installRuntime();
      setProgress(r.ok ? `已安装运行时：${r.path ?? ""}` : `安装失败：${r.error ?? "见日志"}`);
      await refreshRuntime();
    } catch (e) {
      setProgress(`安装失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRtInstalling(false);
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
    if (expanded === repoId) return setExpanded(null);
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
      const contextSize = m.contextDefault ?? 4096;
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
      await getClient().unloadModel(m.routerId ?? m.path);
      await refreshLocal();
      onChange();
    } finally {
      setBusy(null);
    }
  };
  // 启用某个嵌入模型为向量记忆引擎（独立进程，不进 router）。
  const enableEmbed = async (m: LocalModel) => {
    setEmbedBusy(true);
    setProgress(`启用向量记忆：${m.fileName}…（启动嵌入进程 + 重建索引）`);
    try {
      const r = await getClient().enableEmbedding({ modelPath: m.path });
      setEmbed(r);
      setProgress(`向量记忆已启用（${r.dim} 维，重建索引 ${r.reindexed} 条）`);
      await refreshLocal();
    } catch (e) {
      setProgress(`启用失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setEmbedBusy(false);
    }
  };

  const addProvider = async () => {
    if (!prov.id.trim() || !prov.baseUrl.trim()) return setProvNote("请填写 id 与 baseUrl");
    try {
      const ctx = Number(prov.context.trim());
      await getClient().addProvider({
        id: prov.id.trim(),
        baseUrl: prov.baseUrl.trim(),
        ...(prov.apiKey ? { apiKey: prov.apiKey } : {}),
        models: prov.models.split(",").map((s) => s.trim()).filter(Boolean),
        ...(Number.isFinite(ctx) && ctx > 0 ? { contextWindow: Math.floor(ctx) } : {}),
      });
      setProv({ id: "", baseUrl: "", apiKey: "", models: "", context: "" });
      setView("list");
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
      await refreshProviders();
      onChange();
    } catch (e) {
      setProvNote(`删除失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const progressNote = progress && (
    <div className="note">
      {progress}
      {pct != null && (
        <div className="progress">
          <div className="progress-fill" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );

  // ===== 子视图：HF 搜索 / 下载 =====
  if (tab === "local" && view === "search") {
    return (
      <div className="page mdl-page">
        <div className="skill-detail-head">
          <button className="files-back" onClick={() => setView("list")}>
            <ArrowLeftIcon size={15} /> 返回
          </button>
          <span className="skill-detail-name">下载模型</span>
        </div>
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
        {progressNote}
        {searched && (
          <section className="search-panel">
            <div className="sp-head">
              <span>搜索结果 · {results.length}</span>
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
      </div>
    );
  }

  // ===== 子视图：添加云端 Provider =====
  if (tab === "cloud" && view === "add-provider") {
    return (
      <div className="page mdl-page">
        <div className="skill-detail-head">
          <button className="files-back" onClick={() => setView("list")}>
            <ArrowLeftIcon size={15} /> 返回
          </button>
          <span className="skill-detail-name">添加云端 Provider</span>
        </div>
        {provNote && <div className="note">{provNote}</div>}
        <p className="hint" style={{ marginBottom: 10 }}>任意 OpenAI 兼容端点（/v1）。Key 持久化在本机 daemon。</p>
        <div className="prov-presets">
          {PROVIDER_PRESETS.map((p) => (
            <button key={p.id} className="prov-preset" title={p.baseUrl} onClick={() => setProv({ ...prov, id: prov.id || p.id, baseUrl: p.baseUrl })}>
              {p.label}
            </button>
          ))}
        </div>
        <div className="form">
          <input placeholder="id（如 openrouter）" value={prov.id} onChange={(e) => setProv({ ...prov, id: e.target.value })} />
          <input placeholder="baseUrl（.../v1）" value={prov.baseUrl} onChange={(e) => setProv({ ...prov, baseUrl: e.target.value })} />
          <input placeholder="API Key" type="password" value={prov.apiKey} onChange={(e) => setProv({ ...prov, apiKey: e.target.value })} />
          <input placeholder="模型（逗号分隔）" value={prov.models} onChange={(e) => setProv({ ...prov, models: e.target.value })} />
          <input
            type="number"
            min={1}
            placeholder="上下文大小（token，如 131072）"
            title="云端模型无法自动探测上下文窗口，手动填写用于压缩阈值与进度环；留空默认 32768"
            value={prov.context}
            onChange={(e) => setProv({ ...prov, context: e.target.value })}
          />
          <button onClick={() => void addProvider()}>添加</button>
        </div>
      </div>
    );
  }

  // ===== 主视图：本地 / 云端 卡片列表 =====
  return (
    <div className="page mdl-page">
      <div className="mdl-head">
        <div className="seg mdl-tabs">
          <button className={tab === "local" ? "on" : ""} onClick={() => setTab("local")}>
            <BoxIcon size={14} /> 本地
          </button>
          <button className={tab === "cloud" ? "on" : ""} onClick={() => setTab("cloud")}>
            <GlobeIcon size={14} /> 云端
          </button>
        </div>
        <span className="bar-spacer" />
        {tab === "local" ? (
          <button className="set-add icon" title="下载模型" onClick={() => setView("search")}>
            <SearchIcon size={16} />
          </button>
        ) : (
          <button className="set-add icon" title="添加 Provider" onClick={() => setView("add-provider")}>
            <PlusIcon size={16} />
          </button>
        )}
      </div>
      {progressNote}

      {tab === "local" ? (
        <>
          {runtime && !runtime.found && (
            <div className="rt-banner warn">
              <AlertIcon size={15} />
              <div className="rt-banner-body">
                <div>
                  未检测到本地推理运行时（<code>llama-server</code> / <code>llama</code>）。本地模型需要它才能运行。
                </div>
                <div className="rt-banner-cmd">一键安装（llama.app 官方）：<code>{runtime.install}</code></div>
              </div>
              <button className="rt-install" disabled={rtInstalling} onClick={() => void installRuntime()}>
                {rtInstalling ? "安装中…" : "安装运行时"}
              </button>
            </div>
          )}
          {local.length === 0 ? (
            <div className="empty-models">
              <BoxIcon size={26} />
              <p>还没有本地模型</p>
              <span>点右上「下载模型」搜索并下载一个 GGUF 模型即可开始。</span>
            </div>
          ) : (
            <div className="mdl-list">
              {local.map((m) => {
                const kind = modelKind(m);
                const isEmbed = kind === "embed";
                const embedReady = isEmbed && !!embed?.ready && embed.modelId === m.path;
                const isLoaded = isEmbed ? embedReady : loaded.includes(m.routerId ?? m.path);
                const isBusy = busy === m.path;
                const quant = quantOf(m);
                return (
                  <div key={m.id} className="mdl-card">
                    <span className={`mdl-glyph k-${kind}`}>
                      <BoxIcon size={18} />
                    </span>
                    <div className="mdl-body">
                      <div className="mdl-name-row">
                        <span className="mdl-name mono" title={m.fileName}>
                          {displayName(m, quant)}
                        </span>
                        <span className="set-pill ghost">{KIND_LABEL[kind]}</span>
                        {isLoaded && (
                          <span className="mdl-live">
                            <span className="mcp-dot ok" /> 运行中
                          </span>
                        )}
                      </div>
                      <div className="mdl-specs">
                        {(m.repoId ?? m.arch) && <span>{m.repoId ?? m.arch}</span>}
                        <span>ctx {fmtCtx(m.contextDefault)}</span>
                        {quant && <span>{quant}</span>}
                        <span>{fmtSize(m.sizeBytes)}</span>
                      </div>
                    </div>
                    {isEmbed ? (
                      embedReady ? (
                        <button className="set-add" disabled title="向量记忆已启用">
                          已启用
                        </button>
                      ) : (
                        <button className="set-add primary" disabled={embedBusy} onClick={() => void enableEmbed(m)}>
                          {embedBusy ? "启用中…" : "启用向量"}
                        </button>
                      )
                    ) : isLoaded ? (
                      <button className="set-add" disabled={isBusy} onClick={() => void unload(m)}>
                        {isBusy ? "卸载中…" : "卸载"}
                      </button>
                    ) : (
                      <button className="set-add primary" disabled={isBusy} onClick={() => void load(m)}>
                        {isBusy ? "加载中…" : "加载"}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      ) : (
        <>
          {provNote && <div className="note">{provNote}</div>}
          {providers.length === 0 ? (
            <div className="empty-models">
              <GlobeIcon size={26} />
              <p>还没有云端 Provider</p>
              <span>点右上「添加 Provider」接入一个 OpenAI 兼容端点即可在聊天中选用。</span>
            </div>
          ) : (
            <div className="mdl-list">
              {providers.map((p) => (
                <div key={p.id} className="mdl-card">
                  <span className="mdl-glyph k-text">
                    <GlobeIcon size={18} />
                  </span>
                  <div className="mdl-body">
                    <div className="mdl-name-row">
                      <span className="mdl-name mono">{p.id}</span>
                      {p.contextWindow ? <span className="set-pill ghost">ctx {fmtCtx(p.contextWindow)}</span> : null}
                    </div>
                    <div className="mdl-specs">
                      <span>{p.baseUrl}</span>
                    </div>
                    {p.models.length > 0 && <div className="mdl-specs">{p.models.join("、")}</div>}
                  </div>
                  <button className="mcp-icon-btn danger" title="删除" onClick={() => void removeProvider(p.id)}>
                    <TrashIcon size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
