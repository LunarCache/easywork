import { useCallback, useEffect, useRef, useState } from "react";
import type { GGUFVariant, HFModelSummary, LocalModel } from "@ew/shared";
import type {
  ProviderCatalogItem,
  ProviderCatalogModel,
  ProviderApiFamily,
  ProviderInfo,
  ProviderModelConfig,
  ProviderModelModality,
  LocalNetInfo,
} from "@ew/sdk";
import { getClient } from "../lib/client.js";
import { useConfirm } from "../components/ConfirmDialog.js";
import { BrandIcon, brandKeyForModel, brandKeyForProvider } from "../components/BrandIcon.js";
import {
  AlertIcon,
  BoxIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronIcon,
  DownloadIcon,
  EditIcon,
  GlobeIcon,
  SearchIcon,
  TrashIcon,
  PlusIcon,
  ArrowLeftIcon,
} from "../icons.js";

type ModelsTab = "local" | "cloud";
type View = "list" | "search" | "add-provider";

const PROVIDER_CATALOG_FEATURED = new Set([
  "openai",
  "anthropic",
  "google",
  "mistral",
  "openrouter",
  "deepseek",
  "xai",
  "groq",
  "amazon-bedrock",
  "azure-openai-responses",
  "github-copilot",
  "vercel-ai-gateway",
]);

interface ProviderFormModel {
  rowId: string;
  id: string;
  context: string;
  inputModalities: ProviderModelModality[];
}

function resetScrollContainers(node: HTMLElement | null) {
  if (!node) return;
  let el: HTMLElement | null = node;
  while (el) {
    const overflowY = window.getComputedStyle(el).overflowY;
    if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") {
      el.scrollTo({ top: 0 });
    }
    el = el.parentElement;
  }
}

function newProviderModelRow(input: Omit<ProviderFormModel, "rowId"> = {
  id: "",
  context: "32768",
  inputModalities: ["text"],
}): ProviderFormModel {
  return { ...input, rowId: crypto.randomUUID() };
}

function catalogModelsToForm(models: ProviderCatalogModel[]): ProviderFormModel[] {
  return models.map((m) => newProviderModelRow({
    id: m.id,
    context: String(m.contextWindow),
    inputModalities: m.inputModalities.includes("image") ? ["text", "image"] : ["text"],
  }));
}

function modelConfigsToForm(models: ProviderModelConfig[]): ProviderFormModel[] {
  const rows = models.map((m) => newProviderModelRow({
    id: m.id,
    context: String(m.contextWindow),
    inputModalities: m.inputModalities.includes("image") ? ["text", "image"] : ["text"],
  }));
  return rows.length > 0 ? rows : [newProviderModelRow()];
}

function formModelsToConfig(models: ProviderFormModel[]): ProviderModelConfig[] {
  const out = new Map<string, ProviderModelConfig>();
  for (const model of models) {
    const id = model.id.trim();
    if (!id) continue;
    const ctx = Number(model.context.trim());
    const inputModalities = model.inputModalities.includes("image") ? ["text", "image"] as ProviderModelModality[] : ["text"] as ProviderModelModality[];
    out.set(id, {
      id,
      inputModalities,
      contextWindow: Number.isFinite(ctx) && ctx > 0 ? Math.floor(ctx) : 32768,
    });
  }
  return [...out.values()];
}

function apiLabel(api: string, options: ProviderApiFamily[]): string {
  return options.find((item) => item.id === api)?.label ?? api;
}

function formatApiFamilies(options: ProviderApiFamily[], fallback: string[] = []): string {
  const labels = options.length ? options.map((item) => item.label) : fallback;
  return labels.join(" / ");
}

function fmtSize(bytes: number): string {
  const mb = bytes / 1e6;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}
/** 生成一个随机 api-key（暴露 0.0.0.0 时用）。 */
function genApiKey(): string {
  return "ew-" + crypto.randomUUID().replace(/-/g, "");
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
  const addProviderPageRef = useRef<HTMLDivElement>(null);
  const { confirm: askConfirm, dialog: confirmDialog } = useConfirm();
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
  const [runtime, setRuntime] = useState<{ found: boolean; path?: string; install: string } | null>(null);
  const [rtInstalling, setRtInstalling] = useState(false);

  // 网络访问（暴露模型服务到局域网：llama router + /v1 网关）。
  const [net, setNet] = useState<LocalNetInfo | null>(null);
  const [netBusy, setNetBusy] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState("");

  // 云端 provider
  const [prov, setProv] = useState({
    kind: "pi-native" as "openai-compatible" | "pi-native",
    id: "",
    api: "",
    baseUrl: "",
    apiKey: "",
    models: "",
    context: "",
  });
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [providerCatalog, setProviderCatalog] = useState<ProviderCatalogItem[]>([]);
  const [providerApiFamilies, setProviderApiFamilies] = useState<ProviderApiFamily[]>([]);
  const [providerCatalogLoading, setProviderCatalogLoading] = useState(false);
  const [providerConfigOpen, setProviderConfigOpen] = useState(false);
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);
  const [apiMenuOpen, setApiMenuOpen] = useState(false);
  const [providerModels, setProviderModels] = useState<ProviderFormModel[]>([]);
  const [modelProbeBusy, setModelProbeBusy] = useState(false);
  const [provNote, setProvNote] = useState("");

  useEffect(() => {
    if (!providerConfigOpen) setApiMenuOpen(false);
  }, [providerConfigOpen]);

  const openAddProvider = () => {
    setProviderConfigOpen(false);
    setEditingProviderId(null);
    setProvNote("");
    setView("add-provider");
  };

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
  const refreshNet = useCallback(async () => {
    try {
      setNet(await getClient().getLocalNet());
    } catch {
      /* ignore */
    }
  }, []);
  // 切换绑定 127.0.0.1 ⇄ 0.0.0.0（暴露须 api-key：输入框 / 现有 / 自动生成）。重载 router。
  const changeBind = async (host: "127.0.0.1" | "0.0.0.0") => {
    if (netBusy || net?.bindHost === host) return;
    const apiKey = host === "0.0.0.0" ? apiKeyInput.trim() || net?.apiKey || genApiKey() : undefined;
    setNetBusy(true);
    setProgress(host === "0.0.0.0" ? "正在重载模型并暴露到局域网…" : "正在重载模型并收回到本机…");
    try {
      const r = await getClient().setLocalNet(host, apiKey);
      setNet(r);
      setApiKeyInput("");
      setProgress(host === "0.0.0.0" ? "已暴露到局域网（0.0.0.0）" : "已收回到仅本机（127.0.0.1）");
    } catch (e) {
      setProgress(`切换失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setNetBusy(false);
    }
  };
  /** 端点对外可用 URL：绑 0.0.0.0 时其他设备用本机局域网 IP。 */
  const endpointUrl = (port: number): string => {
    const host = net?.bindHost === "0.0.0.0" ? net?.lanIp ?? "0.0.0.0" : "127.0.0.1";
    return `http://${host}:${port}/v1`;
  };
  const refreshProviders = useCallback(async () => {
    try {
      setProviders(await getClient().listProviders());
    } catch {
      /* ignore */
    }
  }, []);
  const refreshProviderCatalog = useCallback(async () => {
    setProviderCatalogLoading(true);
    try {
      const catalog = await getClient().providerCatalogInfo();
      setProviderCatalog(catalog.providers);
      setProviderApiFamilies(catalog.apiFamilies);
    } catch {
      /* ignore */
    } finally {
      setProviderCatalogLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshLocal();
    void refreshRuntime();
    void refreshNet();
  }, [refreshLocal, refreshRuntime, refreshNet]);
  useEffect(() => {
    if (tab === "cloud") {
      void refreshProviders();
      void refreshProviderCatalog();
    }
  }, [tab, refreshProviders, refreshProviderCatalog]);

  useEffect(() => {
    if (tab !== "cloud" || view !== "add-provider") return;
    requestAnimationFrame(() => resetScrollContainers(addProviderPageRef.current));
  }, [providerConfigOpen, tab, view]);

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
    setProgress(`加载 ${m.fileName}…（首次启动本地推理需几秒）`);
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
  // 删除本地模型：从磁盘移除 GGUF（含分片 / 同目录 mmproj）。后端先卸载再删，受管目录硬校验。
  const delLocal = async (m: LocalModel) => {
    const label = displayName(m, quantOf(m));
    const isEmbed = modelKind(m) === "embed";
    const activeEmbed = isEmbed && !!embed?.ready && embed.modelId === m.path;
    let body = "将从磁盘删除其 GGUF 文件（含分片与同目录 mmproj），不可恢复。";
    if (activeEmbed) {
      body += "\n\n⚠ 该模型正用作向量记忆引擎——删除后记忆 / 知识库的向量召回会降级为纯词法，需重新下载并启用嵌入模型才能恢复。";
    } else if (isEmbed) {
      body += "\n\n注：这是嵌入模型，若已用于向量记忆，删除后需重新启用。";
    }
    if (!(await askConfirm({ title: `删除本地模型「${label}」？`, body, danger: true }))) return;
    setBusy(m.path);
    try {
      const { removed } = await getClient().deleteLocalModel(m.path);
      setProgress(`已删除 ${removed.length} 个文件：${label}`);
      await refreshLocal();
      onChange();
    } catch (e) {
      setProgress(`删除失败：${e instanceof Error ? e.message : String(e)}`);
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
    if (!prov.id.trim()) return setProvNote("请填写 Provider ID");
    if (prov.kind === "openai-compatible" && !prov.baseUrl.trim()) return setProvNote("OpenAI-compatible provider 需要 baseUrl");
    const modelConfigs = formModelsToConfig(providerModels);
    if (modelConfigs.length === 0) return setProvNote("请至少添加一个模型");
    try {
      await getClient().addProvider({
        id: prov.id.trim(),
        kind: prov.kind,
        ...(prov.api.trim() ? { api: prov.api.trim() } : {}),
        ...(prov.baseUrl.trim() ? { baseUrl: prov.baseUrl.trim() } : {}),
        ...(prov.apiKey ? { apiKey: prov.apiKey } : {}),
        modelConfigs,
      });
      setProv({ kind: "pi-native", id: "", api: "", baseUrl: "", apiKey: "", models: "", context: "" });
      setProviderModels([newProviderModelRow()]);
      setProviderConfigOpen(false);
      setEditingProviderId(null);
      setView("list");
      await refreshProviders();
      onChange();
    } catch (e) {
      setProvNote(`${editingProviderId ? "保存" : "添加"}失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const removeProvider = async (id: string) => {
    if (!(await askConfirm({ title: `删除云端 provider「${id}」？`, body: "其下的模型将不再可用。", danger: true }))) return;
    try {
      await getClient().removeProvider(id);
      await refreshProviders();
      onChange();
    } catch (e) {
      setProvNote(`删除失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const applyCustomProvider = () => {
    setEditingProviderId(null);
    setProv({
      kind: "openai-compatible",
      id: "",
      api: "openai-completions",
      baseUrl: "",
      apiKey: prov.apiKey,
      models: "",
      context: "",
    });
    setProviderModels([newProviderModelRow()]);
    setProviderConfigOpen(true);
    setProvNote("");
  };

  const featuredCatalog = providerCatalog.filter((p) => PROVIDER_CATALOG_FEATURED.has(p.id));
  const restCatalog = providerCatalog.filter((p) => !PROVIDER_CATALOG_FEATURED.has(p.id));
  const selectedCatalog = providerCatalog.find((p) => p.id === prov.id);
  const applyCatalogProvider = (p: ProviderCatalogItem) => {
    setEditingProviderId(null);
    setProv({
      kind: "pi-native",
      id: p.id,
      api: p.apiOptions[0]?.id ?? p.apiFamilies[0] ?? "",
      baseUrl: "",
      apiKey: prov.apiKey,
      models: p.models.map((m) => m.id).join(", "),
      context: "",
    });
    setProviderModels(catalogModelsToForm(p.models));
    setProviderConfigOpen(true);
    setProvNote("");
  };
  const editProvider = (p: ProviderInfo) => {
    const kind = p.kind ?? "openai-compatible";
    setEditingProviderId(p.id);
    setProv({
      kind,
      id: p.id,
      api: p.api ?? (kind === "openai-compatible" ? "openai-completions" : ""),
      baseUrl: p.baseUrl ?? "",
      apiKey: "",
      models: p.models.join(", "),
      context: "",
    });
    setProviderModels(modelConfigsToForm(p.modelConfigs));
    setProviderConfigOpen(true);
    setProvNote("");
    setView("add-provider");
  };

  const providerModelIds = providerModels.map((m) => m.id).filter(Boolean);
  const addProviderModelRow = () => {
    setProviderModels((cur) => [...cur, newProviderModelRow()]);
  };
  const removeProviderModel = (rowId: string) => {
    setProviderModels((cur) => {
      const next = cur.filter((m) => m.rowId !== rowId);
      return next.length > 0 ? next : [newProviderModelRow()];
    });
  };
  const updateProviderModel = (rowId: string, patch: Partial<Omit<ProviderFormModel, "rowId">>) => {
    setProviderModels((cur) => cur.map((m) => (m.rowId === rowId ? { ...m, ...patch } : m)));
  };
  const apiProtocolIds = [
    ...new Set([
      prov.api,
      ...(selectedCatalog?.apiOptions.map((item) => item.id) ?? selectedCatalog?.apiFamilies ?? []),
      ...(prov.kind === "openai-compatible" ? providerApiFamilies.map((item) => item.id) : []),
    ].filter(Boolean)),
  ];
  const apiProtocolOptions = [...providerApiFamilies, ...(selectedCatalog?.apiOptions ?? [])];
  const fetchProviderModels = async () => {
    if (prov.kind !== "openai-compatible") return;
    if (!prov.baseUrl.trim()) return setProvNote("请先填写 Base URL");
    setModelProbeBusy(true);
    setProvNote("");
    try {
      const result = await getClient().probeProviderModelConfigs({
        baseUrl: prov.baseUrl.trim(),
        ...(prov.apiKey.trim() ? { apiKey: prov.apiKey.trim() } : {}),
      });
      if (result.modelConfigs.length === 0) {
        setProvNote("未获取到模型列表，请手动填入模型 ID。");
      } else {
        setProviderModels(modelConfigsToForm(result.modelConfigs));
        setProvNote(`已获取 ${result.modelConfigs.length} 个模型。`);
      }
    } catch (e) {
      setProvNote(`获取模型列表失败：${e instanceof Error ? e.message : String(e)}。请手动填入模型 ID。`);
    } finally {
      setModelProbeBusy(false);
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
          <button className="set-btn primary" onClick={() => void search()} disabled={searching}>
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
                        <button className="set-btn small" onClick={() => void download(v)}>
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
      <div className="page mdl-page" ref={addProviderPageRef}>
        <div className="skill-detail-head">
          <button className="files-back" onClick={() => setView("list")}>
            <ArrowLeftIcon size={15} /> 返回
          </button>
          <div>
            <span className="skill-detail-name">{editingProviderId ? "编辑云端 Provider" : "添加云端 Provider"}</span>
            <p className="provider-subtitle">{editingProviderId ? "调整连接信息、模型 ID、上下文窗口和模态。" : "选择模型服务商后填写连接信息；自定义服务商支持兼容端点。"}</p>
          </div>
        </div>
        {provNote && <div className="note">{provNote}</div>}
        {providerConfigOpen ? (
          <div className="provider-config-view">
            <div className="provider-form-panel provider-form-panel-open">
              <div className="provider-panel-head">
                <div>
                  <div className="provider-panel-title">连接配置</div>
                  <div className="provider-panel-desc">API Key 仅持久化在本机 daemon。</div>
                </div>
                <div className="provider-panel-actions">
                  {selectedCatalog ? <span className="set-pill ghost">{selectedCatalog.modelCount} models</span> : null}
                  <button
                    className="set-btn ghost soft small"
                    onClick={() => {
                      if (editingProviderId) {
                        setEditingProviderId(null);
                        setView("list");
                      } else {
                        setProviderConfigOpen(false);
                      }
                    }}
                  >
                    {editingProviderId ? "取消编辑" : "更换服务商"}
                  </button>
                </div>
              </div>
              <div className="provider-form-grid">
                <label className="provider-field">
                  <span>Provider ID</span>
                  <input
                    placeholder="openrouter"
                    value={prov.id}
                    disabled={!!editingProviderId}
                    onChange={(e) => {
                      setProv({ ...prov, id: e.target.value });
                    }}
                  />
                </label>
                <div className="provider-field">
                  <span>API 协议</span>
                  <div className="set-select-wrap provider-api-select">
                    <button
                      type="button"
                      className={`set-select-btn ${apiMenuOpen ? "open" : ""}`}
                      onClick={() => setApiMenuOpen((open) => !open)}
                    >
                      <span>{prov.api ? apiLabel(prov.api, apiProtocolOptions) : "选择 API 协议"}</span>
                      <ChevronDownIcon size={13} className="set-select-chev" />
                    </button>
                    {apiMenuOpen && (
                      <>
                        <div className="menu-backdrop" onClick={() => setApiMenuOpen(false)} />
                        <div className="set-select-menu">
                          {apiProtocolIds.map((api) => (
                            <button
                              key={api}
                              type="button"
                              className={`set-select-opt ${api === prov.api ? "on" : ""}`}
                              onClick={() => {
                                setProv({ ...prov, api });
                                setApiMenuOpen(false);
                              }}
                            >
                              <span>{apiLabel(api, apiProtocolOptions)}</span>
                              {api === prov.api && <CheckIcon size={14} className="set-select-check" />}
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                </div>
                <label className="provider-field wide">
                  <span>{prov.kind === "pi-native" ? "Base URL Override" : "Base URL"}</span>
                  <div className="provider-inline-control">
                    <input
                      placeholder={prov.kind === "pi-native" ? "留空使用内置端点" : "https://.../v1"}
                      value={prov.baseUrl}
                      onChange={(e) => setProv({ ...prov, baseUrl: e.target.value })}
                    />
                    {prov.kind === "openai-compatible" && (
                      <button className="set-btn secondary" type="button" disabled={modelProbeBusy} onClick={() => void fetchProviderModels()}>
                        {modelProbeBusy ? "获取中…" : "获取模型列表"}
                      </button>
                    )}
                  </div>
                </label>
                <label className="provider-field wide">
                  <span>API Key</span>
                  <input
                    placeholder={editingProviderId ? "留空保持现有 Key" : "sk-..."}
                    type="password"
                    value={prov.apiKey}
                    onChange={(e) => setProv({ ...prov, apiKey: e.target.value })}
                  />
                </label>
                <div className="provider-field wide">
                  <div className="provider-field-head">
                    <span>模型配置</span>
                    <span className="set-pill ghost">{providerModelIds.length} models</span>
                  </div>
                  <div className="provider-model-table">
                    <div className="provider-model-table-head">
                      <span>Model ID</span>
                      <span>Context</span>
                      <span>模态</span>
                      <button type="button" className="mcp-icon-btn" title="添加模型行" onClick={addProviderModelRow}>
                        <PlusIcon size={14} />
                      </button>
                    </div>
                    {providerModels.map((model) => (
                      <div className="provider-model-row" key={model.rowId}>
                        <input
                          className="mono"
                          value={model.id}
                          placeholder="model-id"
                          title={model.id}
                          onChange={(e) => updateProviderModel(model.rowId, { id: e.target.value })}
                        />
                        <input
                          type="number"
                          min={1}
                          value={model.context}
                          placeholder="32768"
                          onChange={(e) => updateProviderModel(model.rowId, { context: e.target.value })}
                        />
                        <label className="provider-model-check">
                          <input
                            type="checkbox"
                            checked={model.inputModalities.includes("image")}
                            onChange={(e) => updateProviderModel(model.rowId, { inputModalities: e.target.checked ? ["text", "image"] : ["text"] })}
                          />
                          视觉
                        </label>
                        <button type="button" className="mcp-icon-btn danger" title="移除" onClick={() => removeProviderModel(model.rowId)}>
                          <TrashIcon size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              {selectedCatalog ? (
                <div className="provider-native-note">
                  <BrandIcon brand={brandKeyForProvider(selectedCatalog.id)} size="sm" />
                  <span>内置信息：{formatApiFamilies(selectedCatalog.apiOptions, selectedCatalog.apiFamilies)}</span>
                  <span>已载入 {selectedCatalog.models.length} 个模型</span>
                </div>
              ) : prov.kind === "openai-compatible" ? (
                <div className="provider-native-note muted">自定义模型服务商将按兼容端点接入。</div>
              ) : (
                <div className="provider-native-note muted">选择内置服务商后可查看对应的连接信息。</div>
              )}
              <div className="provider-form-actions">
                <button
                  className="set-btn ghost soft"
                  onClick={() => {
                    setProv(editingProviderId
                      ? { ...prov, baseUrl: "", apiKey: "", models: "", context: "" }
                      : { kind: "pi-native", id: "", api: "", baseUrl: "", apiKey: "", models: "", context: "" });
                    setProviderModels([newProviderModelRow()]);
                  }}
                >
                  清空
                </button>
                <button className="set-btn primary" onClick={() => void addProvider()}>
                  {editingProviderId ? "保存配置" : "添加 Provider"}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="provider-template-panel provider-picker-panel">
              <div className="provider-panel-head">
                <div>
                  <div className="provider-panel-title">自定义模型服务商</div>
                  <div className="provider-panel-desc">接入兼容端点，手动维护模型 ID、上下文窗口和模态。</div>
                </div>
                <span className="set-pill ghost">手动配置</span>
              </div>
              <button
                className="provider-template provider-template-custom"
                title="自定义兼容端点"
                onClick={applyCustomProvider}
              >
                <BrandIcon brand="generic" size="lg" />
                <span className="provider-template-main">
                  <span className="provider-template-name">自定义模型服务商</span>
                  <span className="provider-template-url">自定义兼容端点</span>
                  <span className="provider-template-hint">填写任意兼容端点、模型 ID 与上下文窗口。</span>
                </span>
              </button>
            </div>

            <div className="provider-catalog">
              <div className="provider-catalog-head">
                <div>
                  <div className="provider-panel-title">内置支持</div>
                  <div className="provider-panel-desc">来自当前安装的模型服务商与模型目录。</div>
                </div>
                <span className="set-pill ghost">{providerCatalogLoading ? "扫描中" : `${providerCatalog.length} providers`}</span>
              </div>
              <div className="provider-catalog-grid">
                {[...featuredCatalog, ...restCatalog].map((p) => (
                  <button key={p.id} className="provider-catalog-card" onClick={() => applyCatalogProvider(p)}>
                    <BrandIcon brand={brandKeyForProvider(p.id)} size="md" />
                    <div className="provider-catalog-body">
                      <div className="provider-catalog-name">
                        <span>{p.label}</span>
                        <span className="set-pill ghost">内置</span>
                      </div>
                      <div className="provider-catalog-meta">{p.modelCount} models · {formatApiFamilies(p.apiOptions, p.apiFamilies)}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    );
  }

  // ===== 主视图：本地 / 云端 卡片列表 =====
  return (
    <div className="page mdl-page" data-testid="models-page">
      <div className="mdl-head">
        <div className="seg mdl-tabs" data-testid="models-tabs">
          <button
            className={tab === "local" ? "on" : ""}
            data-testid="models-tab-local"
            data-active={tab === "local" ? "1" : "0"}
            onClick={() => setTab("local")}
          >
            <BoxIcon size={14} /> 本地
          </button>
          <button
            className={tab === "cloud" ? "on" : ""}
            data-testid="models-tab-cloud"
            data-active={tab === "cloud" ? "1" : "0"}
            onClick={() => setTab("cloud")}
          >
            <GlobeIcon size={14} /> 云端
          </button>
        </div>
        <span className="bar-spacer" />
        {tab === "local" ? (
          <button className="set-btn primary" title="搜索并下载 HuggingFace GGUF 模型" onClick={() => setView("search")}>
            <DownloadIcon size={16} /> 下载模型
          </button>
        ) : (
          <button className="set-btn primary" title="添加云端模型 Provider" onClick={openAddProvider}>
            <PlusIcon size={16} /> 添加 Provider
          </button>
        )}
      </div>
      {progressNote}

      {tab === "local" ? (
        <>
          {/* 网络访问：把模型服务（llama router + /v1 网关）暴露到局域网 */}
          <div className="set-group">
            <div className="set-row">
              <div className="set-row-info">
                <div className="set-row-title">暴露到局域网</div>
                <div className="set-row-desc">开启后局域网内其它设备可直连模型服务（绑定 0.0.0.0，须 api-key）；关闭则仅本机。</div>
              </div>
              <button
                className={`set-toggle ${net?.bindHost === "0.0.0.0" ? "on" : ""}`}
                disabled={netBusy}
                onClick={() => void changeBind(net?.bindHost === "0.0.0.0" ? "127.0.0.1" : "0.0.0.0")}
                title={net?.bindHost === "0.0.0.0" ? "收回到仅本机" : "暴露到局域网"}
              >
                <span />
              </button>
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
                <button className="set-btn secondary" disabled={netBusy} onClick={() => setApiKeyInput(genApiKey())}>
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
          {runtime && !runtime.found && (
            <div className="rt-banner warn">
              <AlertIcon size={15} />
              <div className="rt-banner-body">
                <div>
                  未检测到本地推理运行时（<code>llama</code>，来自 llama.app）。本地模型需要它才能运行。
                </div>
                <div className="rt-banner-cmd">一键安装（llama.app 官方）：<code>{runtime.install}</code></div>
              </div>
              <button className="set-btn primary" disabled={rtInstalling} onClick={() => void installRuntime()}>
                {rtInstalling ? "安装中…" : "安装运行时"}
              </button>
            </div>
          )}
          {local.length === 0 ? (
            <div className="empty-models">
              <BoxIcon size={26} />
              <p>还没有本地模型</p>
              <span>搜索 GGUF 模型并下载到本机。</span>
              <button className="set-btn primary empty-action" onClick={() => setView("search")}>
                <DownloadIcon size={15} /> 下载模型
              </button>
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
                    <BrandIcon brand={brandKeyForModel(m.repoId, m.fileName, m.arch)} size="lg" />
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
                        <button className="set-btn secondary" disabled title="向量记忆已启用">
                          已启用
                        </button>
                      ) : (
                        <button className="set-btn secondary" disabled={embedBusy} onClick={() => void enableEmbed(m)}>
                          {embedBusy ? "启用中…" : "启用向量"}
                        </button>
                      )
                    ) : isLoaded ? (
                      <button className="set-btn secondary" disabled={isBusy} onClick={() => void unload(m)}>
                        {isBusy ? "卸载中…" : "卸载"}
                      </button>
                    ) : (
                      <button className="set-btn secondary" disabled={isBusy} onClick={() => void load(m)}>
                        {isBusy ? "加载中…" : "加载"}
                      </button>
                    )}
                    <button
                      className="mcp-icon-btn danger"
                      title="删除本地模型（从磁盘移除）"
                      disabled={isBusy}
                      onClick={() => void delLocal(m)}
                    >
                      <TrashIcon size={14} />
                    </button>
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
              <span>接入 OpenAI 兼容端点。</span>
            </div>
          ) : (
            <div className="mdl-list">
              {providers.map((p) => (
                <div key={p.id} className="mdl-card">
                  <BrandIcon brand={brandKeyForProvider(p.id, p.baseUrl)} size="lg" />
                  <div className="mdl-body">
                    <div className="mdl-name-row">
                      <span className="mdl-name mono">{p.id}</span>
                      <span className="set-pill ghost">{p.kind === "pi-native" ? "内置" : "OpenAI /v1"}</span>
                    </div>
                    <div className="mdl-specs">
                      <span>{p.kind === "pi-native" ? p.api ?? "内置端点" : p.baseUrl}</span>
                      {p.kind === "pi-native" && p.baseUrl ? <span>override {p.baseUrl}</span> : null}
                    </div>
                  </div>
                  <button className="mcp-icon-btn" title="编辑" onClick={() => editProvider(p)}>
                    <EditIcon size={14} />
                  </button>
                  <button className="mcp-icon-btn danger" title="删除" onClick={() => void removeProvider(p.id)}>
                    <TrashIcon size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {confirmDialog}
    </div>
  );
}
