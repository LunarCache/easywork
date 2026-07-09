import {
  getModel as defaultGetPiModel,
  getModels as defaultGetPiModels,
  getProviders as defaultGetPiProviders,
} from "@earendil-works/pi-ai";
import { z } from "zod";
import type {
  CloudProviderConfig,
  CloudProviderKind,
  CloudProviderModelConfig,
  CloudProviderModelModality,
} from "./manager.js";

type PiProvider = ReturnType<typeof defaultGetPiProviders>[number];

export const ProviderModelConfigSchema = z.object({
  id: z.string().min(1),
  contextWindow: z.number().int().positive(),
  inputModalities: z.array(z.enum(["text", "image"])).min(1),
});

export const ProviderConfigSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["openai-compatible", "pi-native"]).default("openai-compatible"),
  baseUrl: z.string().url().optional(),
  api: z.string().min(1).optional(),
  apiKey: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  modelConfigs: z.array(ProviderModelConfigSchema).min(1),
}).superRefine((cfg, ctx) => {
  if (cfg.kind === "openai-compatible" && !cfg.baseUrl) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["baseUrl"],
      message: "baseUrl is required for openai-compatible providers",
    });
  }
});

export const ProviderModelProbeSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

export type ProviderModelProbeInput = z.infer<typeof ProviderModelProbeSchema>;
export type NormalizedCloudProviderConfig = CloudProviderConfig & { kind: CloudProviderKind };

export interface ProviderApiFamily {
  id: string;
  label: string;
}

export interface ProviderCatalogModel {
  id: string;
  name: string;
  api: string;
  contextWindow: number;
  inputModalities: CloudProviderModelModality[];
}

export interface ProviderCatalogItem {
  id: string;
  label: string;
  apiFamilies: string[];
  apiOptions: ProviderApiFamily[];
  modelCount: number;
  sampleModels: string[];
  models: ProviderCatalogModel[];
}

export interface ProviderCatalogInfo {
  providers: ProviderCatalogItem[];
  apiFamilies: ProviderApiFamily[];
}

export interface ProviderModelProbeResult {
  modelConfigs: CloudProviderModelConfig[];
  models: string[];
}

export interface ProviderRuntimeModel {
  id: string;
  name: string;
  reasoning: false;
  input: CloudProviderModelModality[];
  cost: { input: 0; output: 0; cacheRead: 0; cacheWrite: 0 };
  contextWindow: number;
  maxTokens: 4096;
  headers?: Record<string, string>;
}

interface PiCatalogModel {
  id: string;
  name: string;
  api: string;
  contextWindow: number;
  input: CloudProviderModelModality[];
}

export interface ProviderCatalogDeps {
  fetchImpl?: typeof fetch;
  getPiProviders?: () => string[];
  getPiModels?: (provider: string) => PiCatalogModel[];
}

export const DEFAULT_COMPATIBLE_CONTEXT_WINDOW = 32768;

const API_FAMILY_LABELS: Record<string, string> = {
  "openai-completions": "OpenAI Chat Completions",
  "openai-responses": "OpenAI Responses",
  "anthropic-messages": "Anthropic Messages",
  "google-generative-ai": "Google Generative AI",
  "mistral-conversations": "Mistral Conversations",
  "azure-openai-responses": "Azure OpenAI Responses",
  "bedrock-converse-stream": "Bedrock Converse",
  "google-vertex": "Google Vertex",
};

const COMPATIBLE_API_FAMILIES = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
  "mistral-conversations",
  "azure-openai-responses",
  "bedrock-converse-stream",
  "google-vertex",
];

const PI_PROVIDER_LABELS: Record<string, string> = {
  "amazon-bedrock": "Amazon Bedrock",
  "ant-ling": "Ant Ling",
  anthropic: "Anthropic",
  "azure-openai-responses": "Azure OpenAI",
  cerebras: "Cerebras",
  "cloudflare-ai-gateway": "Cloudflare AI Gateway",
  "cloudflare-workers-ai": "Cloudflare Workers AI",
  deepseek: "DeepSeek",
  fireworks: "Fireworks",
  "github-copilot": "GitHub Copilot",
  google: "Google Gemini",
  "google-vertex": "Google Vertex AI",
  groq: "Groq",
  huggingface: "Hugging Face",
  "kimi-coding": "Kimi For Coding",
  minimax: "MiniMax",
  "minimax-cn": "MiniMax China",
  mistral: "Mistral",
  moonshotai: "Moonshot AI",
  "moonshotai-cn": "Moonshot AI China",
  nvidia: "NVIDIA NIM",
  opencode: "OpenCode Zen",
  "opencode-go": "OpenCode Go",
  openai: "OpenAI",
  "openai-codex": "OpenAI Codex",
  openrouter: "OpenRouter",
  together: "Together AI",
  "vercel-ai-gateway": "Vercel AI Gateway",
  xai: "xAI",
  xiaomi: "Xiaomi MiMo",
  "xiaomi-token-plan-ams": "Xiaomi MiMo Amsterdam",
  "xiaomi-token-plan-cn": "Xiaomi MiMo China",
  "xiaomi-token-plan-sgp": "Xiaomi MiMo Singapore",
  zai: "ZAI",
  "zai-coding-cn": "ZAI Coding Plan China",
};

const PI_PROVIDER_ORDER = [
  "openai",
  "anthropic",
  "google",
  "google-vertex",
  "mistral",
  "openrouter",
  "deepseek",
  "xai",
  "groq",
  "vercel-ai-gateway",
  "amazon-bedrock",
  "azure-openai-responses",
  "openai-codex",
  "github-copilot",
  "moonshotai",
  "zai",
  "minimax",
  "huggingface",
  "together",
  "fireworks",
  "cloudflare-ai-gateway",
  "cloudflare-workers-ai",
  "nvidia",
  "cerebras",
];

export class ProviderCatalog {
  private readonly fetchImpl: typeof fetch;
  private readonly getPiProviders: () => string[];
  private readonly getPiModels: (provider: string) => PiCatalogModel[];

  constructor(deps: ProviderCatalogDeps = {}) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.getPiProviders = deps.getPiProviders ?? (() => defaultGetPiProviders());
    this.getPiModels = deps.getPiModels ?? ((provider) => defaultGetPiModels(provider as PiProvider) as PiCatalogModel[]);
  }

  builtInProviders(): ProviderCatalogItem[] {
    const order = new Map(PI_PROVIDER_ORDER.map((id, index) => [id, index]));
    return this.getPiProviders()
      .map((id) => {
        const models = this.getPiModels(id);
        return {
          id,
          label: PI_PROVIDER_LABELS[id] ?? titleFromId(id),
          apiFamilies: [...new Set(models.map((m) => m.api))],
          apiOptions: apiOptionsForIds([...new Set(models.map((m) => m.api))]),
          modelCount: models.length,
          sampleModels: models.slice(0, 3).map((m) => m.id),
          models: models.map((m) => ({
            id: m.id,
            name: m.name,
            api: m.api,
            contextWindow: m.contextWindow,
            inputModalities: normalizeModalities(m.input),
          })),
        };
      })
      .sort((a, b) => {
        const ap = order.get(a.id) ?? Number.MAX_SAFE_INTEGER;
        const bp = order.get(b.id) ?? Number.MAX_SAFE_INTEGER;
        if (ap !== bp) return ap - bp;
        return a.label.localeCompare(b.label);
      });
  }

  info(): ProviderCatalogInfo {
    return {
      providers: this.builtInProviders(),
      apiFamilies: apiOptionsForIds(COMPATIBLE_API_FAMILIES),
    };
  }

  compatibleApiFamilies(): ProviderApiFamily[] {
    return apiOptionsForIds(COMPATIBLE_API_FAMILIES);
  }

  async probeCompatibleModels(input: ProviderModelProbeInput): Promise<ProviderModelProbeResult> {
    const base = input.baseUrl.replace(/\/+$/, "");
    const urls = [new URL(`${base}/models`).toString()];
    if (!/\/v1$/i.test(base)) urls.push(new URL(`${base}/v1/models`).toString());

    let lastError = "";
    for (const url of [...new Set(urls)]) {
      try {
        const res = await this.fetchImpl(url, {
          headers: {
            accept: "application/json",
            ...(input.apiKey ? { authorization: `Bearer ${input.apiKey}` } : {}),
            ...(input.headers ?? {}),
          },
        });
        if (!res.ok) {
          lastError = `${res.status} ${res.statusText}`.trim();
          continue;
        }
        const modelConfigs = modelConfigsFromResponse(await res.json());
        if (modelConfigs.length > 0) {
          return { modelConfigs, models: modelConfigs.map((model) => model.id) };
        }
        lastError = "empty model list";
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
      }
    }
    throw new Error(lastError || "model list probe failed");
  }
}

export function normalizeProviderConfig(cfg: CloudProviderConfig): NormalizedCloudProviderConfig {
  const kind = cfg.kind ?? "openai-compatible";
  if (kind === "openai-compatible" && !cfg.baseUrl) {
    throw new Error("openai-compatible provider requires baseUrl");
  }
  const modelConfigs = normalizeModelConfigs(cfg.modelConfigs);
  if (modelConfigs.length === 0) {
    throw new Error("provider requires at least one modelConfig");
  }
  return {
    ...cfg,
    kind,
    modelConfigs,
    ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl.replace(/\/$/, "") } : {}),
  };
}

export function modelIdsForProvider(cfg: CloudProviderConfig): string[] {
  return cfg.modelConfigs.map((m) => m.id);
}

export function modelConfigForModel(cfg: CloudProviderConfig, modelId: string): CloudProviderModelConfig | undefined {
  return cfg.modelConfigs?.find((m) => m.id === modelId);
}

export function contextWindowForModel(cfg: CloudProviderConfig, modelId: string): number | undefined {
  return modelConfigForModel(cfg, modelId)?.contextWindow
    ?? ((cfg.kind ?? "openai-compatible") === "pi-native"
      ? defaultGetPiModel(cfg.id as PiProvider, modelId as never)?.contextWindow
      : undefined);
}

export function inputModalitiesForModel(cfg: CloudProviderConfig, modelId: string): CloudProviderModelModality[] {
  return modelConfigForModel(cfg, modelId)?.inputModalities ?? ["text"];
}

export function runtimeModelsForProviderConfig(cfg: CloudProviderConfig): ProviderRuntimeModel[] {
  return modelIdsForProvider(cfg).map((modelId) => runtimeModelForProviderConfig(cfg, modelId));
}

export function runtimeModelForProviderConfig(cfg: CloudProviderConfig, modelId: string): ProviderRuntimeModel {
  return {
    id: modelId,
    name: modelId,
    reasoning: false,
    input: inputModalitiesForModel(cfg, modelId),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: contextWindowForModel(cfg, modelId) ?? DEFAULT_COMPATIBLE_CONTEXT_WINDOW,
    maxTokens: 4096,
    ...(cfg.headers ? { headers: cfg.headers } : {}),
  };
}

function modelConfigsFromResponse(payload: unknown): CloudProviderModelConfig[] {
  const data = (payload as { data?: unknown })?.data;
  const rawItems = Array.isArray(data) ? data : Array.isArray(payload) ? payload : [];
  const out = new Map<string, CloudProviderModelConfig>();
  for (const item of rawItems) {
    const model = modelConfigFromResponseItem(item);
    if (model && !out.has(model.id)) out.set(model.id, model);
  }
  return [...out.values()];
}

function normalizeModelConfigs(configs: CloudProviderModelConfig[]): CloudProviderModelConfig[] {
  const out = new Map<string, CloudProviderModelConfig>();
  for (const cfg of configs) {
    const id = cfg.id.trim();
    if (!id) continue;
    const inputModalities = normalizeModalities(cfg.inputModalities);
    const contextWindow = Math.floor(cfg.contextWindow);
    if (!Number.isFinite(contextWindow) || contextWindow <= 0) continue;
    out.set(id, {
      id,
      contextWindow,
      inputModalities,
    });
  }
  return [...out.values()];
}

function modelConfigFromResponseItem(item: unknown): CloudProviderModelConfig | undefined {
  const id = (typeof item === "string" ? item : (item as { id?: unknown })?.id)?.toString().trim();
  if (!id) return undefined;
  return {
    id,
    contextWindow: readPositiveInt(item, ["contextWindow", "context_window", "context_length", "max_context_length"])
      ?? DEFAULT_COMPATIBLE_CONTEXT_WINDOW,
    inputModalities: normalizeModalities(readStringArray(item, ["inputModalities", "input_modalities", "input", "modalities"])),
  };
}

function readPositiveInt(item: unknown, keys: string[]): number | undefined {
  if (!item || typeof item !== "object") return undefined;
  for (const key of keys) {
    const value = (item as Record<string, unknown>)[key];
    const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return undefined;
}

function readStringArray(item: unknown, keys: string[]): string[] | undefined {
  if (!item || typeof item !== "object") return undefined;
  for (const key of keys) {
    const value = (item as Record<string, unknown>)[key];
    if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  }
  return undefined;
}

function normalizeModalities(values: readonly string[] | undefined): CloudProviderModelModality[] {
  const out = (values ?? []).filter((m, index, all): m is CloudProviderModelModality =>
    (m === "text" || m === "image") && all.indexOf(m) === index);
  return out.includes("text") ? out : ["text", ...out];
}

function apiOptionsForIds(ids: string[]): ProviderApiFamily[] {
  return ids.map((id) => ({ id, label: API_FAMILY_LABELS[id] ?? titleFromId(id) }));
}

function titleFromId(id: string): string {
  return id
    .split("-")
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}
