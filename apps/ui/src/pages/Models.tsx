import { useCallback, useEffect, useRef, useState } from "react";
import type { GGUFVariant, HFModelSummary, LocalModel, SamplingParams } from "@ew/shared";
import type {
  ProviderCatalogItem,
  ProviderCatalogModel,
  ProviderCatalogRef,
  ProviderCompatibilityMode,
  ProviderApiFamily,
  ProviderInfo,
  ProviderModelConfig,
  ProviderModelModality,
  LocalNetInfo,
} from "@ew/sdk";
import { getClient } from "../lib/client.js";
import { useConfirm } from "../components/ConfirmDialog.js";
import { BrandIcon, brandKeyForModel, brandKeyForProvider } from "../components/BrandIcon.js";
import { ConfigEmptyState, ConfigResourceCard, ConfigToolbar } from "../components/ConfigPrimitives.js";
import {
  AlertIcon,
  BoxIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronIcon,
  DownloadIcon,
  EditIcon,
  GlobeIcon,
  SlidersIcon,
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

const DEFAULT_PROVIDER_API_FAMILIES: ProviderApiFamily[] = [
  { id: "openai-completions", label: "OpenAI Chat Completions" },
  { id: "openai-responses", label: "OpenAI Responses" },
  { id: "anthropic-messages", label: "Anthropic Messages" },
  { id: "google-generative-ai", label: "Google Generative AI" },
  { id: "mistral-conversations", label: "Mistral Conversations" },
  { id: "azure-openai-responses", label: "Azure OpenAI Responses" },
  { id: "bedrock-converse-stream", label: "Bedrock Converse" },
  { id: "google-vertex", label: "Google Vertex" },
];

interface ProviderFormModel {
  rowId: string;
  id: string;
  connectionId: string;
  context: string;
  inputModalities: ProviderModelModality[];
  reasoning?: boolean;
  compatibilityMode: ProviderCompatibilityMode;
  catalogRef?: ProviderCatalogRef;
}

interface ProviderConnectionDraft {
  id: string;
  api?: string;
  baseUrl?: string;
}

const DEFAULT_PROVIDER_CONNECTION_ID = "default";

function effectiveProviderConnection(
  connection: ProviderConnectionDraft,
  defaultApi: string,
  defaultBaseUrl: string,
): { api: string; baseUrl: string } {
  return {
    api: connection.api ?? defaultApi,
    baseUrl: connection.baseUrl ?? defaultBaseUrl,
  };
}

interface CatalogModelMatch {
  provider: ProviderCatalogItem;
  model: ProviderCatalogModel;
  ref: ProviderCatalogRef;
}

type SamplingKey = "temperature" | "topP" | "topK" | "minP" | "repeatPenalty" | "maxTokens";
type SamplingDraft = Record<SamplingKey, string>;

const SAMPLING_FIELDS: { key: SamplingKey; label: string; placeholder: string; step: string; hint: string }[] = [
  { key: "temperature", label: "温度", placeholder: "默认", step: "0.05", hint: "越低越稳定" },
  { key: "topP", label: "top_p", placeholder: "默认", step: "0.05", hint: "核心采样概率" },
  { key: "topK", label: "top_k", placeholder: "默认", step: "1", hint: "本地 llama" },
  { key: "minP", label: "min_p", placeholder: "默认", step: "0.01", hint: "本地 llama" },
  { key: "repeatPenalty", label: "重复惩罚", placeholder: "默认", step: "0.05", hint: "本地 llama" },
  { key: "maxTokens", label: "最大输出", placeholder: "不限", step: "64", hint: "单轮上限" },
];

const SAMPLING_PRESETS: { label: string; values: Partial<Record<SamplingKey, number>> }[] = [
  { label: "严谨", values: { temperature: 0.2, topP: 0.8, repeatPenalty: 1.08 } },
  { label: "均衡", values: { temperature: 0.7, topP: 0.9, topK: 40, repeatPenalty: 1.05 } },
  { label: "发散", values: { temperature: 1, topP: 0.95, topK: 80, minP: 0.02 } },
];

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
  connectionId: DEFAULT_PROVIDER_CONNECTION_ID,
  context: "32768",
  inputModalities: ["text"],
  compatibilityMode: "auto",
}): ProviderFormModel {
  return { ...input, rowId: crypto.randomUUID() };
}

function catalogModelsToForm(models: ProviderCatalogModel[]): ProviderFormModel[] {
  return models.map((m) => newProviderModelRow({
    id: m.id,
    connectionId: DEFAULT_PROVIDER_CONNECTION_ID,
    context: String(m.contextWindow),
    inputModalities: m.inputModalities.includes("image") ? ["text", "image"] : ["text"],
    compatibilityMode: "auto",
  }));
}

function catalogMatches(
  catalog: ProviderCatalogItem[],
  modelId: string,
): CatalogModelMatch[] {
  const id = modelId.trim();
  if (!id) return [];
  return catalog.flatMap((provider) => provider.models
    .filter((model) => model.id === id)
    .map((model) => ({
      provider,
      model,
      ref: { providerId: provider.id, modelId: model.id },
    })));
}

function sameCatalogRef(a: ProviderCatalogRef | undefined, b: ProviderCatalogRef): boolean {
  return a?.providerId === b.providerId && a.modelId === b.modelId;
}

function catalogMatchForRef(
  catalog: ProviderCatalogItem[],
  ref: ProviderCatalogRef | undefined,
): CatalogModelMatch | undefined {
  if (!ref) return undefined;
  const provider = catalog.find((item) => item.id === ref.providerId);
  const model = provider?.models.find((item) => item.id === ref.modelId);
  return provider && model ? { provider, model, ref } : undefined;
}

function searchCatalogMatches(
  catalog: ProviderCatalogItem[],
  query: string,
): CatalogModelMatch[] {
  const needle = query.trim().toLowerCase();
  return catalog.flatMap((provider) => provider.models
    .filter((model) => {
      if (!needle) return false;
      return `${provider.id} ${provider.label} ${model.id} ${model.name}`.toLowerCase().includes(needle);
    })
    .map((model) => ({ provider, model, ref: { providerId: provider.id, modelId: model.id } })))
    .sort((a, b) => {
      const aExact = a.model.id.toLowerCase() === needle ? 0 : 1;
      const bExact = b.model.id.toLowerCase() === needle ? 0 : 1;
      return aExact - bExact || a.provider.label.localeCompare(b.provider.label);
    })
    .slice(0, 24);
}

/** UI-only suggestion for editable/display projections; Core resolves the effective runtime template. */
function suggestedCatalogProjection(matches: CatalogModelMatch[], modelId: string): CatalogModelMatch | undefined {
  const lowerId = modelId.trim().toLowerCase();
  return matches.find(({ provider }) => lowerId.startsWith(provider.id.toLowerCase()))
    ?? (matches.length === 1 ? matches[0] : undefined);
}

/** Copies explicit catalog values into saved user-editable context/modality fields, never runtime capabilities. */
function catalogProjectionPatch(
  match: CatalogModelMatch | undefined,
): Partial<Omit<ProviderFormModel, "rowId">> {
  if (!match) return { catalogRef: undefined };
  return {
    catalogRef: match.ref,
    context: String(match.model.contextWindow),
    inputModalities: match.model.inputModalities.includes("image") ? ["text", "image"] : ["text"],
  };
}

function modelConfigsToForm(
  models: ProviderModelConfig[],
  catalog: ProviderCatalogItem[] = [],
  inheritCatalogMetadata = false,
  savedConnections: ProviderConnectionDraft[] = [],
): { models: ProviderFormModel[]; connections: ProviderConnectionDraft[] } {
  const connections: ProviderConnectionDraft[] = savedConnections.map((connection) => ({ ...connection }));
  const connectionIds = new Map<string, string>();
  for (const connection of connections) {
    connectionIds.set(`${connection.api ?? "<inherit>"}\n${connection.baseUrl ?? "<inherit>"}`, connection.id);
  }
  const connectionFor = (model: ProviderModelConfig): string => {
    if (!model.api && !model.baseUrl) return DEFAULT_PROVIDER_CONNECTION_ID;
    const key = `${model.api ?? "<inherit>"}\n${model.baseUrl ?? "<inherit>"}`;
    const existing = connectionIds.get(key);
    if (existing) return existing;
    const id = crypto.randomUUID();
    connectionIds.set(key, id);
    connections.push({
      id,
      ...(model.api ? { api: model.api } : {}),
      ...(model.baseUrl ? { baseUrl: model.baseUrl } : {}),
    });
    return id;
  };
  const rows = models.map((model) => {
    const compatibilityMode = model.compatibilityMode ?? "auto";
    const pinnedMatch = catalogMatchForRef(catalog, model.catalogRef);
    const suggestedMatch = compatibilityMode === "auto"
      ? suggestedCatalogProjection(catalogMatches(catalog, model.id), model.id)
      : undefined;
    const match = compatibilityMode === "generic" ? undefined : pinnedMatch ?? suggestedMatch;
    const catalogRef = catalog.length > 0 ? match?.ref : model.catalogRef;
    return newProviderModelRow({
      id: model.id,
      connectionId: connectionFor(model),
      context: String(model.contextWindow),
      inputModalities: model.inputModalities.includes("image") ? ["text", "image"] : ["text"],
      compatibilityMode,
      ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
      ...(catalogRef ? { catalogRef } : {}),
      ...(inheritCatalogMetadata ? catalogProjectionPatch(match) : {}),
    });
  });
  return {
    models: rows.length > 0 ? rows : [newProviderModelRow()],
    connections,
  };
}

function formModelsToConfig(
  models: ProviderFormModel[],
  connections: ProviderConnectionDraft[],
): ProviderModelConfig[] {
  const connectionById = new Map(connections.map((connection) => [connection.id, connection]));
  const out = new Map<string, ProviderModelConfig>();
  for (const model of models) {
    const id = model.id.trim();
    if (!id) continue;
    const ctx = Number(model.context.trim());
    const inputModalities = model.inputModalities.includes("image") ? ["text", "image"] as ProviderModelModality[] : ["text"] as ProviderModelModality[];
    const connection = connectionById.get(model.connectionId);
    out.set(id, {
      id,
      ...(connection?.api?.trim() ? { api: connection.api.trim() } : {}),
      ...(connection?.baseUrl?.trim() ? { baseUrl: connection.baseUrl.trim() } : {}),
      inputModalities,
      contextWindow: Number.isFinite(ctx) && ctx > 0 ? Math.floor(ctx) : 32768,
      compatibilityMode: model.compatibilityMode,
      ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
      ...(model.catalogRef ? { catalogRef: model.catalogRef } : {}),
    });
  }
  return [...out.values()];
}

function connectionEndpointPreview(api: string, baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/$/, "");
  if (!base) return "填写 Base URL 后显示最终请求地址";
  if (api === "anthropic-messages") {
    if (base.endsWith("/v1/messages")) return base;
    return base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`;
  }
  if (api === "openai-completions") return `${base}/chat/completions`;
  if (api === "openai-responses" || api === "azure-openai-responses") return `${base}/responses`;
  return `${base} · ${apiLabel(api, DEFAULT_PROVIDER_API_FAMILIES)}`;
}

function apiLabel(api: string, options: ProviderApiFamily[]): string {
  return options.find((item) => item.id === api)?.label ?? api;
}

function compactApiLabel(api: string): string {
  if (api === "openai-completions") return "OpenAI Chat";
  if (api === "openai-responses") return "OpenAI Responses";
  if (api === "anthropic-messages") return "Anthropic";
  if (api === "google-generative-ai") return "Google AI";
  if (api === "mistral-conversations") return "Mistral";
  if (api === "azure-openai-responses") return "Azure OpenAI";
  if (api === "bedrock-converse-stream") return "Bedrock";
  if (api === "google-vertex") return "Vertex";
  return api;
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

function localModelKey(m: LocalModel): string {
  return m.routerId ?? m.path;
}

function samplingToDraft(sampling: SamplingParams | undefined): SamplingDraft {
  return Object.fromEntries(
    SAMPLING_FIELDS.map(({ key }) => [key, sampling?.[key] == null ? "" : String(sampling[key])]),
  ) as SamplingDraft;
}

function draftToSampling(draft: SamplingDraft): SamplingParams {
  const out: SamplingParams = {};
  for (const { key } of SAMPLING_FIELDS) {
    const raw = draft[key].trim();
    if (!raw) continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`${key} 不是有效数字`);
    if ((key === "topK" || key === "maxTokens") && !Number.isInteger(value)) throw new Error(`${key} 需要整数`);
    out[key] = value;
  }
  return out;
}

function samplingSummary(sampling: SamplingParams | undefined): string {
  if (!sampling || Object.keys(sampling).length === 0) return "使用默认采样";
  const parts: string[] = [];
  if (sampling.temperature != null) parts.push(`temp ${sampling.temperature}`);
  if (sampling.topP != null) parts.push(`top_p ${sampling.topP}`);
  if (sampling.topK != null) parts.push(`top_k ${sampling.topK}`);
  if (sampling.minP != null) parts.push(`min_p ${sampling.minP}`);
  if (sampling.repeatPenalty != null) parts.push(`repeat ${sampling.repeatPenalty}`);
  if (sampling.maxTokens != null) parts.push(`max ${sampling.maxTokens}`);
  return parts.join(" · ");
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
  const [searchError, setSearchError] = useState<string | null>(null);
  const [variants, setVariants] = useState<Record<string, GGUFVariant[]>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [progress, setProgress] = useState("");
  const [pct, setPct] = useState<number | null>(null);

  // 本地模型
  const [local, setLocal] = useState<LocalModel[]>([]);
  const [loaded, setLoaded] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [tuningModelId, setTuningModelId] = useState<string | null>(null);
  const [samplingDraft, setSamplingDraft] = useState<SamplingDraft>(() => samplingToDraft(undefined));
  const [samplingSaving, setSamplingSaving] = useState(false);
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
  const [providerApiFamilies, setProviderApiFamilies] = useState<ProviderApiFamily[]>(DEFAULT_PROVIDER_API_FAMILIES);
  const [providerCatalogLoading, setProviderCatalogLoading] = useState(false);
  const [providerConfigOpen, setProviderConfigOpen] = useState(false);
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);
  const [apiMenuOpen, setApiMenuOpen] = useState(false);
  const [templateMenuRowId, setTemplateMenuRowId] = useState<string | null>(null);
  const [templateSearch, setTemplateSearch] = useState("");
  const [providerModels, setProviderModels] = useState<ProviderFormModel[]>([]);
  const [providerConnections, setProviderConnections] = useState<ProviderConnectionDraft[]>([]);
  const [advancedModelRowId, setAdvancedModelRowId] = useState<string | null>(null);
  const [selectedProviderModelRows, setSelectedProviderModelRows] = useState<string[]>([]);
  const [modelProbeBusy, setModelProbeBusy] = useState(false);
  const [provNote, setProvNote] = useState("");

  useEffect(() => {
    if (!providerConfigOpen) {
      setApiMenuOpen(false);
      setTemplateMenuRowId(null);
      setTemplateSearch("");
      setAdvancedModelRowId(null);
      setSelectedProviderModelRows([]);
    }
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
    setSearchError(null);
    try {
      setResults(await getClient().searchModels(query.trim()));
      setSearched(true);
    } catch (error) {
      setResults([]);
      setSearched(false);
      const detail = error instanceof Error ? error.message : String(error);
      setSearchError(`搜索失败：${detail}。请检查网络，或在“设置 → 通用”中启用 HF 镜像。`);
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
      body += "\n\n⚠ 该模型正用作向量记忆引擎——删除后记忆的向量召回会降级为纯词法，需重新下载并启用嵌入模型才能恢复。";
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

  const openSampling = (m: LocalModel) => {
    const id = localModelKey(m);
    if (tuningModelId === id) {
      setTuningModelId(null);
      return;
    }
    setTuningModelId(id);
    setSamplingDraft(samplingToDraft(m.settings?.sampling));
  };

  const applySamplingPreset = (values: Partial<Record<SamplingKey, number>>) => {
    const next = Object.fromEntries(
      SAMPLING_FIELDS.map(({ key }) => [key, values[key] == null ? "" : String(values[key])]),
    ) as Partial<SamplingDraft>;
    setSamplingDraft((cur) => ({ ...cur, ...next }));
  };

  const saveLocalSampling = async (modelId: string) => {
    setSamplingSaving(true);
    try {
      const sampling = draftToSampling(samplingDraft);
      const settings = await getClient().saveLocalModelSettings(modelId, { sampling });
      setLocal((cur) => cur.map((m) => (localModelKey(m) === modelId ? { ...m, settings } : m)));
      setProgress(Object.keys(settings.sampling ?? {}).length ? "已保存模型运行参数" : "已恢复模型默认采样");
      setTuningModelId(null);
    } catch (e) {
      setProgress(`保存运行参数失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSamplingSaving(false);
    }
  };

  const addProvider = async () => {
    if (!prov.id.trim()) return setProvNote("请填写 Provider ID");
    if (prov.kind === "openai-compatible" && !prov.baseUrl.trim()) return setProvNote("OpenAI-compatible provider 需要 baseUrl");
    const usedConnectionIds = new Set(providerModels.map((model) => model.connectionId));
    const incompleteConnection = providerConnections.find((connection) => {
      const effective = effectiveProviderConnection(connection, prov.api, prov.baseUrl);
      return usedConnectionIds.has(connection.id) && (!effective.api.trim() || !effective.baseUrl.trim());
    });
    if (incompleteConnection) return setProvNote("请补全模型正在使用的连接方式");
    const modelConfigs = formModelsToConfig(providerModels, providerConnections);
    if (modelConfigs.length === 0) return setProvNote("请至少添加一个模型");
    const connections = providerConnections.map((connection) => ({
      id: connection.id,
      ...(connection.api?.trim() ? { api: connection.api.trim() } : {}),
      ...(connection.baseUrl?.trim() ? { baseUrl: connection.baseUrl.trim() } : {}),
    }));
    try {
      await getClient().addProvider({
        id: prov.id.trim(),
        kind: prov.kind,
        ...(prov.api.trim() ? { api: prov.api.trim() } : {}),
        ...(prov.baseUrl.trim() ? { baseUrl: prov.baseUrl.trim() } : {}),
        ...(prov.apiKey ? { apiKey: prov.apiKey } : {}),
        ...(prov.kind === "openai-compatible" && connections.length > 0 ? { connections } : {}),
        modelConfigs,
      });
      setProv({ kind: "pi-native", id: "", api: "", baseUrl: "", apiKey: "", models: "", context: "" });
      setProviderModels([newProviderModelRow()]);
      setProviderConnections([]);
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
    setProviderConnections([]);
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
    setProviderConnections([]);
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
    const formState = modelConfigsToForm(
      p.modelConfigs,
      kind === "openai-compatible" ? providerCatalog : [],
      false,
      p.connections ?? [],
    );
    setProviderModels(formState.models);
    setProviderConnections(formState.connections);
    setProviderConfigOpen(true);
    setProvNote("");
    setView("add-provider");
  };

  const providerModelIds = providerModels.map((m) => m.id).filter(Boolean);
  const providerConnectionOptions: ProviderConnectionDraft[] = [
    { id: DEFAULT_PROVIDER_CONNECTION_ID, api: prov.api || "openai-completions", baseUrl: prov.baseUrl },
    ...providerConnections,
  ];
  const providerConnectionLabel = (connection: ProviderConnectionDraft, index: number): string => {
    if (connection.id === DEFAULT_PROVIDER_CONNECTION_ID) return "默认";
    const effective = effectiveProviderConnection(connection, prov.api, prov.baseUrl);
    return `连接 ${index + 1} · ${compactApiLabel(effective.api)}`;
  };
  const allProviderModelsSelected = providerModels.length > 0
    && providerModels.every((model) => selectedProviderModelRows.includes(model.rowId));
  const addProviderModelRow = () => {
    setProviderModels((cur) => [...cur, newProviderModelRow()]);
  };
  const removeProviderModel = (rowId: string) => {
    setProviderModels((cur) => {
      const next = cur.filter((m) => m.rowId !== rowId);
      return next.length > 0 ? next : [newProviderModelRow()];
    });
    setSelectedProviderModelRows((current) => current.filter((id) => id !== rowId));
    if (advancedModelRowId === rowId) setAdvancedModelRowId(null);
  };
  const updateProviderModel = (rowId: string, patch: Partial<Omit<ProviderFormModel, "rowId">>) => {
    setProviderModels((cur) => cur.map((m) => (m.rowId === rowId ? { ...m, ...patch } : m)));
  };
  const updateProviderModelId = (model: ProviderFormModel, id: string) => {
    const match = model.compatibilityMode === "auto"
      ? suggestedCatalogProjection(catalogMatches(providerCatalog, id), id)
      : undefined;
    updateProviderModel(model.rowId, {
      id,
      ...(model.compatibilityMode === "auto" ? catalogProjectionPatch(match) : {}),
    });
  };
  const addProviderConnection = () => {
    const fallbackApi = apiProtocolIds.find((api) => api !== prov.api) ?? "anthropic-messages";
    setProviderConnections((current) => [...current, {
      id: crypto.randomUUID(),
      api: fallbackApi,
    }]);
  };
  const updateProviderConnection = (id: string, patch: Partial<Omit<ProviderConnectionDraft, "id">>) => {
    setProviderConnections((current) => current.map((connection) =>
      connection.id === id ? { ...connection, ...patch } : connection));
  };
  const removeProviderConnection = (id: string) => {
    setProviderConnections((current) => current.filter((connection) => connection.id !== id));
    setProviderModels((current) => current.map((model) =>
      model.connectionId === id ? { ...model, connectionId: DEFAULT_PROVIDER_CONNECTION_ID } : model));
  };
  const assignSelectedModelsToConnection = (connectionId: string) => {
    const selected = new Set(selectedProviderModelRows);
    setProviderModels((current) => current.map((model) =>
      selected.has(model.rowId) ? { ...model, connectionId } : model));
  };
  const selectProviderApi = (api: string) => {
    setProv({ ...prov, api });
    setTemplateMenuRowId(null);
    if (prov.kind === "openai-compatible") {
      setProviderModels((current) => current.map((model) => {
        if (model.compatibilityMode === "generic") return model;
        const pinned = catalogMatchForRef(providerCatalog, model.catalogRef);
        if (model.compatibilityMode === "catalog" && pinned) return model;
        const match = suggestedCatalogProjection(catalogMatches(providerCatalog, model.id), model.id);
        return {
          ...model,
          compatibilityMode: "auto",
          ...catalogProjectionPatch(match),
        };
      }));
    }
  };
  const availableProviderApiFamilies = providerApiFamilies.length > 0 ? providerApiFamilies : DEFAULT_PROVIDER_API_FAMILIES;
  const apiProtocolIds = [
    ...new Set([
      prov.api,
      ...(selectedCatalog?.apiOptions.map((item) => item.id) ?? selectedCatalog?.apiFamilies ?? []),
      ...(prov.kind === "openai-compatible" ? availableProviderApiFamilies.map((item) => item.id) : []),
    ].filter(Boolean)),
  ];
  const apiProtocolOptions = [...availableProviderApiFamilies, ...(selectedCatalog?.apiOptions ?? [])];
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
        const formState = modelConfigsToForm(
          result.modelConfigs,
          providerCatalog,
          true,
        );
        setProviderModels(formState.models);
        setProviderConnections(formState.connections);
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
        {searchError && <div className="note danger" data-testid="models-search-error">{searchError}</div>}
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
                <label className="provider-field">
                  <span>API Key</span>
                  <input
                    placeholder={editingProviderId ? "留空保持现有 Key" : "sk-..."}
                    type="password"
                    value={prov.apiKey}
                    onChange={(e) => setProv({ ...prov, apiKey: e.target.value })}
                  />
                </label>
                {prov.kind === "openai-compatible" ? (
                  <div className="provider-field wide provider-connections-field">
                    <div className="provider-field-head">
                      <div>
                        <span>连接方式</span>
                        <small>模型只需选择连接方式，不重复填写协议和地址。</small>
                      </div>
                      <button type="button" className="set-btn ghost soft small" onClick={addProviderConnection}>
                        <PlusIcon size={13} /> 添加连接方式
                      </button>
                    </div>
                    <div className="provider-connections">
                      <div className="provider-connection-card default" data-testid="provider-connection-default">
                        <div className="provider-connection-kind">
                          <span className="set-pill">默认</span>
                          <small>新模型自动使用</small>
                        </div>
                        <label>
                          <span>API 协议</span>
                          <select
                            title="默认连接 API 协议"
                            value={prov.api}
                            onChange={(event) => selectProviderApi(event.target.value)}
                          >
                            {apiProtocolIds.map((api) => (
                              <option value={api} key={api}>{apiLabel(api, apiProtocolOptions)}</option>
                            ))}
                          </select>
                        </label>
                        <label className="provider-connection-url">
                          <span>Base URL</span>
                          <input
                            placeholder="https://.../v1"
                            value={prov.baseUrl}
                            onChange={(event) => setProv({ ...prov, baseUrl: event.target.value })}
                          />
                        </label>
                        <button className="set-btn secondary small" type="button" disabled={modelProbeBusy} onClick={() => void fetchProviderModels()}>
                          {modelProbeBusy ? "获取中…" : "获取模型"}
                        </button>
                        <code className="provider-connection-preview">请求 → {connectionEndpointPreview(prov.api, prov.baseUrl)}</code>
                      </div>
                      {providerConnections.map((connection, index) => {
                        const effective = effectiveProviderConnection(connection, prov.api, prov.baseUrl);
                        return (
                        <div className="provider-connection-card" key={connection.id} data-testid="provider-connection-override">
                          <div className="provider-connection-kind">
                            <span className="set-pill ghost">连接 {index + 2}</span>
                            <small>用于连接例外</small>
                          </div>
                          <label>
                            <span>API 协议</span>
                            <select
                              title={`连接 ${index + 2} API 协议`}
                              value={connection.api ?? ""}
                              onChange={(event) => updateProviderConnection(connection.id, { api: event.target.value || undefined })}
                            >
                              <option value="">默认 · {apiLabel(prov.api, apiProtocolOptions)}</option>
                              {apiProtocolIds.map((api) => (
                                <option value={api} key={api}>{apiLabel(api, apiProtocolOptions)}</option>
                              ))}
                            </select>
                          </label>
                          <label className="provider-connection-url">
                            <span>Base URL</span>
                            <input
                              title={`连接 ${index + 2} Base URL`}
                              placeholder={`默认 · ${prov.baseUrl || "Provider Base URL"}`}
                              value={connection.baseUrl ?? ""}
                              onChange={(event) => updateProviderConnection(connection.id, { baseUrl: event.target.value || undefined })}
                            />
                          </label>
                          <button type="button" className="mcp-icon-btn danger" title="删除连接方式" onClick={() => removeProviderConnection(connection.id)}>
                            <TrashIcon size={13} />
                          </button>
                          <code className="provider-connection-preview">请求 → {connectionEndpointPreview(effective.api, effective.baseUrl)}</code>
                        </div>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <>
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
                                    selectProviderApi(api);
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
                      <span>Base URL Override</span>
                      <input
                        placeholder="留空使用内置端点"
                        value={prov.baseUrl}
                        onChange={(event) => setProv({ ...prov, baseUrl: event.target.value })}
                      />
                    </label>
                  </>
                )}
                <div className="provider-field wide">
                  <div className="provider-field-head">
                    <span>模型配置</span>
                    <span className="set-pill ghost">{providerModelIds.length} models</span>
                  </div>
                  <div className="provider-model-table">
                    {prov.kind === "openai-compatible" && selectedProviderModelRows.length > 0 && (
                      <div className="provider-model-bulkbar">
                        <span>已选择 {selectedProviderModelRows.length} 个模型</span>
                        <label>
                          批量接入
                          <select
                            aria-label="批量设置连接方式"
                            value=""
                            onChange={(event) => {
                              assignSelectedModelsToConnection(event.target.value);
                              event.target.value = "";
                            }}
                          >
                            <option value="" disabled>选择连接方式</option>
                            {providerConnectionOptions.map((connection, index) => (
                              <option value={connection.id} key={connection.id}>
                                {providerConnectionLabel(connection, index)}
                              </option>
                            ))}
                          </select>
                        </label>
                        <button type="button" className="set-btn ghost soft small" onClick={() => setSelectedProviderModelRows([])}>取消选择</button>
                      </div>
                    )}
                    <div className={`provider-model-table-head ${prov.kind === "openai-compatible" ? "compatible" : ""}`}>
                      {prov.kind === "openai-compatible" && (
                        <input
                          type="checkbox"
                          aria-label="选择全部模型"
                          checked={allProviderModelsSelected}
                          onChange={(event) => setSelectedProviderModelRows(event.target.checked
                            ? providerModels.map((model) => model.rowId)
                            : [])}
                        />
                      )}
                      <span>Model ID</span>
                      {prov.kind === "openai-compatible" && <span>连接方式</span>}
                      <span>Context</span>
                      <span>{prov.kind === "openai-compatible" ? "能力" : "模态"}</span>
                      {prov.kind === "openai-compatible" && <span>设置</span>}
                      <button type="button" className="mcp-icon-btn" title="添加模型行" onClick={addProviderModelRow}>
                        <PlusIcon size={14} />
                      </button>
                    </div>
                    {providerModels.map((model) => {
                      const exactMatches = catalogMatches(providerCatalog, model.id);
                      const selectedMatch = catalogMatchForRef(providerCatalog, model.catalogRef);
                      const templateMenuOpen = templateMenuRowId === model.rowId;
                      const advancedOpen = advancedModelRowId === model.rowId;
                      const templateOptions = templateMenuOpen
                        ? searchCatalogMatches(providerCatalog, templateSearch)
                        : [];
                      const inheritedReasoning = selectedMatch?.model.reasoning ?? false;
                      const effectiveReasoning = model.reasoning ?? inheritedReasoning;
                      const templateLabel = model.compatibilityMode === "generic"
                        ? "通用兼容"
                        : model.compatibilityMode === "auto"
                          ? "自动匹配"
                          : selectedMatch?.provider.label ?? model.catalogRef?.providerId ?? "选择模板";
                      return (
                      <div className="provider-model-entry" key={model.rowId}>
                      <div className={`provider-model-row ${prov.kind === "openai-compatible" ? "compatible" : ""}`}>
                        {prov.kind === "openai-compatible" && (
                          <input
                            type="checkbox"
                            aria-label={`选择模型 ${model.id || "未命名"}`}
                            checked={selectedProviderModelRows.includes(model.rowId)}
                            onChange={(event) => setSelectedProviderModelRows((current) => event.target.checked
                              ? [...current, model.rowId]
                              : current.filter((id) => id !== model.rowId))}
                          />
                        )}
                        <input
                          className="mono"
                          value={model.id}
                          placeholder="model-id"
                          title={model.id}
                          onChange={(e) => updateProviderModelId(model, e.target.value)}
                        />
                        {prov.kind === "openai-compatible" && (
                          <select
                            className="provider-model-api-select"
                            title="模型连接方式"
                            value={model.connectionId}
                            onChange={(event) => updateProviderModel(model.rowId, { connectionId: event.target.value })}
                          >
                            {providerConnectionOptions.map((connection, index) => (
                              <option value={connection.id} key={connection.id}>
                                {providerConnectionLabel(connection, index)}
                              </option>
                            ))}
                          </select>
                        )}
                        <input
                          type="number"
                          min={1}
                          value={model.context}
                          placeholder="32768"
                          onChange={(e) => updateProviderModel(model.rowId, { context: e.target.value })}
                        />
                        {prov.kind === "openai-compatible" && (
                          <div className="provider-model-capabilities">
                            {model.inputModalities.includes("image") && <span>视觉</span>}
                            {effectiveReasoning && <span>推理</span>}
                            {!model.inputModalities.includes("image") && !effectiveReasoning && <small>文本</small>}
                          </div>
                        )}
                        {prov.kind !== "openai-compatible" && (
                          <label className="provider-model-check">
                            <input
                              type="checkbox"
                              checked={model.inputModalities.includes("image")}
                              onChange={(event) => updateProviderModel(model.rowId, { inputModalities: event.target.checked ? ["text", "image"] : ["text"] })}
                            />
                            视觉
                          </label>
                        )}
                        {prov.kind === "openai-compatible" && (
                          <button
                            type="button"
                            className={`provider-model-advanced-trigger ${advancedOpen ? "open" : ""}`}
                            title="模型高级设置"
                            onClick={() => {
                              setAdvancedModelRowId(advancedOpen ? null : model.rowId);
                              setTemplateMenuRowId(null);
                            }}
                          >
                            <SlidersIcon size={13} /> 高级
                          </button>
                        )}
                        <button type="button" className="mcp-icon-btn danger" title="移除" onClick={() => removeProviderModel(model.rowId)}>
                          <TrashIcon size={13} />
                        </button>
                      </div>
                      {prov.kind === "openai-compatible" && advancedOpen && (
                        <div className="provider-model-advanced">
                          <div className="provider-model-advanced-head">
                            <div>
                              <strong>{model.id || "未命名模型"}</strong>
                              <span>能力覆盖和兼容模板只在需要时调整。</span>
                            </div>
                            <button type="button" className="set-btn ghost soft small" onClick={() => setAdvancedModelRowId(null)}>完成</button>
                          </div>
                          <div className="provider-model-advanced-grid">
                            <label className="provider-model-check advanced">
                              <input
                                type="checkbox"
                                checked={model.inputModalities.includes("image")}
                                onChange={(event) => updateProviderModel(model.rowId, { inputModalities: event.target.checked ? ["text", "image"] : ["text"] })}
                              />
                              支持视觉输入
                            </label>
                            <div className="provider-model-advanced-control">
                              <span>推理能力</span>
                              <div className="provider-reasoning-seg" role="group" aria-label="推理能力">
                                <button
                                  type="button"
                                  className={model.reasoning === undefined ? "on" : ""}
                                  title={`继承模板（当前${inheritedReasoning ? "开启" : "关闭"}）`}
                                  onClick={() => updateProviderModel(model.rowId, { reasoning: undefined })}
                                >继承</button>
                                <button
                                  type="button"
                                  className={model.reasoning === true ? "on" : ""}
                                  title="强制开启推理"
                                  onClick={() => updateProviderModel(model.rowId, { reasoning: true })}
                                >开启</button>
                                <button
                                  type="button"
                                  className={model.reasoning === false ? "on" : ""}
                                  title="强制关闭推理"
                                  onClick={() => updateProviderModel(model.rowId, { reasoning: false })}
                                >关闭</button>
                              </div>
                            </div>
                            <div className="provider-model-advanced-control template">
                              <span>兼容模板</span>
                              <button
                                type="button"
                                className={`provider-model-template-trigger ${templateMenuOpen ? "open" : ""}`}
                                title={selectedMatch ? `当前目录来源：${selectedMatch.provider.label}` : "选择模型兼容模板"}
                                onClick={() => {
                                  setTemplateMenuRowId(templateMenuOpen ? null : model.rowId);
                                  setTemplateSearch(model.catalogRef?.modelId ?? model.id);
                                }}
                              >
                                <span>{templateLabel}</span>
                                <ChevronDownIcon size={12} />
                              </button>
                            </div>
                          </div>
                        </div>
                      )}
                      {prov.kind === "openai-compatible" && templateMenuOpen && (
                        <div className="provider-model-template-menu">
                          <button
                            type="button"
                            className={model.compatibilityMode === "auto" ? "on" : ""}
                            onClick={() => {
                              const match = suggestedCatalogProjection(exactMatches, model.id);
                              updateProviderModel(model.rowId, {
                                compatibilityMode: "auto",
                                ...catalogProjectionPatch(match),
                              });
                              setTemplateMenuRowId(null);
                            }}
                          >
                            <span>自动匹配</span>
                            {model.compatibilityMode === "auto" && <CheckIcon size={13} />}
                          </button>
                          <button
                            type="button"
                            className={model.compatibilityMode === "generic" ? "on" : ""}
                            onClick={() => {
                              updateProviderModel(model.rowId, {
                                compatibilityMode: "generic",
                                catalogRef: undefined,
                              });
                              setTemplateMenuRowId(null);
                            }}
                          >
                            <span>通用兼容</span>
                            {model.compatibilityMode === "generic" && <CheckIcon size={13} />}
                          </button>
                          <input
                            className="provider-model-template-search"
                            value={templateSearch}
                            placeholder="搜索目录模型"
                            onChange={(event) => setTemplateSearch(event.target.value)}
                          />
                          {templateOptions.map((match) => {
                            const selected = model.compatibilityMode === "catalog"
                              && sameCatalogRef(model.catalogRef, match.ref);
                            return (
                              <button
                                type="button"
                                className={selected ? "on" : ""}
                                key={`${match.ref.providerId}:${match.ref.modelId}`}
                                onClick={() => {
                                  updateProviderModel(model.rowId, {
                                    compatibilityMode: "catalog",
                                    ...catalogProjectionPatch(match),
                                  });
                                  setTemplateMenuRowId(null);
                                }}
                              >
                                <span>{match.provider.label}</span>
                                <small>{match.model.name}</small>
                                {selected && <CheckIcon size={13} />}
                              </button>
                            );
                          })}
                          {templateOptions.length === 0 && <span className="provider-model-template-empty">没有找到目录模型</span>}
                        </div>
                      )}
                      </div>
                    );})}
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
                    setProviderConnections([]);
                    setSelectedProviderModelRows([]);
                    setAdvancedModelRowId(null);
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
      <ConfigToolbar
        className="mdl-head"
        actions={tab === "local" ? (
          <button className="set-btn primary" title="搜索并下载 HuggingFace GGUF 模型" onClick={() => setView("search")}>
            <DownloadIcon size={16} /> 下载模型
          </button>
        ) : (
          <button className="set-btn primary" title="添加云端模型 Provider" onClick={openAddProvider}>
            <PlusIcon size={16} /> 添加 Provider
          </button>
        )}
      >
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
      </ConfigToolbar>
      {progressNote}

      {tab === "local" ? (
        <>
          {/* 网络访问：把模型服务（llama router + /v1 网关）暴露到局域网 */}
          <div className={`local-net-panel ${net?.bindHost === "0.0.0.0" ? "exposed" : ""}`}>
            <div className="local-net-main">
              <div className="local-net-copy">
                <div className="local-net-title">
                  <span className={`local-net-dot ${net?.bindHost === "0.0.0.0" ? "on" : ""}`} />
                  <span>网络访问</span>
                  <span className="set-pill ghost">{net?.bindHost === "0.0.0.0" ? "局域网" : "仅本机"}</span>
                </div>
                <div className="local-net-desc">
                  本地默认只监听 127.0.0.1；开启后绑定 0.0.0.0，局域网设备需带 Bearer token 访问。
                </div>
              </div>
              <div className="local-net-controls">
                <input
                  className="local-net-key"
                  placeholder="API Key（留空自动生成）"
                  type="text"
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                />
                <button className="set-btn secondary" disabled={netBusy} onClick={() => setApiKeyInput(genApiKey())}>
                  生成
                </button>
                <button
                  className={`set-toggle ${net?.bindHost === "0.0.0.0" ? "on" : ""}`}
                  disabled={netBusy}
                  onClick={() => void changeBind(net?.bindHost === "0.0.0.0" ? "127.0.0.1" : "0.0.0.0")}
                  title={net?.bindHost === "0.0.0.0" ? "收回到仅本机" : "暴露到局域网"}
                >
                  <span />
                </button>
              </div>
            </div>
            {net?.bindHost === "0.0.0.0" && (
              <div className="local-net-warning">
                <AlertIcon size={13} />
                <span>已暴露到局域网，请仅在可信网络使用。</span>
                <code>Authorization: Bearer {net.apiKey}</code>
              </div>
            )}
            {net && net.endpoints.length > 0 && (
              <div className="local-net-endpoints">
                <span className="local-net-endpoints-label">已加载端点</span>
                {net.endpoints.map((ep) => (
                  <code key={ep.id}>
                    {ep.id.split("/").pop()}{" -> "}{endpointUrl(ep.port)}
                  </code>
                ))}
              </div>
            )}
          </div>
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
            <ConfigEmptyState
              icon={<BoxIcon size={26} />}
              title="还没有本地模型"
              description="搜索 GGUF 模型并下载到本机。"
              action={(
                <button className="set-btn primary" onClick={() => setView("search")}>
                  <DownloadIcon size={15} /> 下载模型
                </button>
              )}
            />
          ) : (
            <div className="mdl-list">
              {local.map((m) => {
                const kind = modelKind(m);
                const isEmbed = kind === "embed";
                const embedReady = isEmbed && !!embed?.ready && embed.modelId === m.path;
                const isLoaded = isEmbed ? embedReady : loaded.includes(m.routerId ?? m.path);
                const isBusy = busy === m.path;
                const quant = quantOf(m);
                const modelId = localModelKey(m);
                const isTuning = tuningModelId === modelId;
                return (
                  <ConfigResourceCard
                    key={m.id}
                    className={`local-model-card ${isTuning ? "tuning" : ""}`}
                    icon={<BrandIcon brand={brandKeyForModel(m.repoId, m.fileName, m.arch)} size="lg" />}
                    actions={(
                      <>
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
                        {!isEmbed && (
                          <button className={`set-btn secondary ${isTuning ? "soft" : ""}`} onClick={() => openSampling(m)}>
                            <EditIcon size={14} />
                            运行参数
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
                      </>
                    )}
                  >
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
                        {!isEmbed && <span>{samplingSummary(m.settings?.sampling)}</span>}
                      </div>
                      {isTuning && (
                        <div className="local-sampling-panel">
                          <div className="local-sampling-head">
                            <div>
                              <strong>默认运行参数</strong>
                              <span>保存后，聊天、工作区和外部渠道下一轮都会使用；留空表示使用引擎默认值。</span>
                            </div>
                            <div className="local-sampling-presets">
                              {SAMPLING_PRESETS.map((preset) => (
                                <button key={preset.label} className="set-btn tiny" onClick={() => applySamplingPreset(preset.values)}>
                                  {preset.label}
                                </button>
                              ))}
                            </div>
                          </div>
                          <div className="local-sampling-grid">
                            {SAMPLING_FIELDS.map((field) => (
                              <label key={field.key} className="local-sampling-field">
                                <span>{field.label}</span>
                                <input
                                  type="number"
                                  step={field.step}
                                  placeholder={field.placeholder}
                                  value={samplingDraft[field.key]}
                                  onChange={(e) => setSamplingDraft((cur) => ({ ...cur, [field.key]: e.target.value }))}
                                />
                                <em>{field.hint}</em>
                              </label>
                            ))}
                          </div>
                          <div className="local-sampling-actions">
                            <button className="set-btn ghost" onClick={() => setSamplingDraft(samplingToDraft(undefined))}>
                              清空
                            </button>
                            <button className="set-btn secondary" onClick={() => setTuningModelId(null)}>
                              取消
                            </button>
                            <button className="set-btn primary" disabled={samplingSaving} onClick={() => void saveLocalSampling(modelId)}>
                              {samplingSaving ? "保存中…" : "保存参数"}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </ConfigResourceCard>
                );
              })}
            </div>
          )}
        </>
      ) : (
        <>
          {provNote && <div className="note">{provNote}</div>}
          {providers.length === 0 ? (
            <ConfigEmptyState icon={<GlobeIcon size={26} />} title="还没有云端 Provider" description="接入兼容端点或内置模型服务商。" />
          ) : (
            <div className="mdl-list provider-list">
              {providers.map((p) => (
                <ConfigResourceCard
                  key={p.id}
                  className="provider-card-compact"
                  icon={<BrandIcon brand={brandKeyForProvider(p.id, p.baseUrl)} size="lg" />}
                  actions={(
                    <>
                      <button className="mcp-icon-btn" title="编辑" onClick={() => editProvider(p)}>
                        <EditIcon size={14} />
                      </button>
                      <button className="mcp-icon-btn danger" title="删除" onClick={() => void removeProvider(p.id)}>
                        <TrashIcon size={14} />
                      </button>
                    </>
                  )}
                >
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
                </ConfigResourceCard>
              ))}
            </div>
          )}
        </>
      )}
      {confirmDialog}
    </div>
  );
}
