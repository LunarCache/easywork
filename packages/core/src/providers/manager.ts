import { OpenAICompatibleEngine } from "@ew/providers";
import type { EngineRegistry } from "../engine/registry.js";
import { getModel as getPiModel } from "@earendil-works/pi-ai";

export type CloudProviderKind = "openai-compatible" | "pi-native";
export type CloudProviderModelModality = "text" | "image";

export interface CloudProviderModelConfig {
  id: string;
  /** Per-model context window. */
  contextWindow: number;
  /** Per-model input modalities for custom compatible endpoints. */
  inputModalities: CloudProviderModelModality[];
}

export interface CloudProviderConfig {
  id: string;
  /** openai-compatible = 自定义 /v1 端点；pi-native = 复用 pi-ai 内置 provider/API family。 */
  kind?: CloudProviderKind;
  /** openai-compatible 必填；pi-native 可选，用作内置 provider endpoint override。 */
  baseUrl?: string;
  /** pi-native 时记录实际 API family，便于 UI/诊断展示；未填则由 pi-ai 内置模型决定。 */
  api?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  /** Per-model metadata. Model ids used for routing are derived from this list. */
  modelConfigs: CloudProviderModelConfig[];
}

/**
 * 云端 provider 管理：把 OpenAI 兼容 provider 注册为引擎并把其模型路由进 EngineRegistry。
 * MVP 阶段配置存内存；阶段 C 接 SQLite + keychain 持久化密钥。
 */
export class ProviderManager {
  private readonly configs = new Map<string, CloudProviderConfig>();
  private readonly fetchImpl?: typeof fetch;

  constructor(
    private readonly registry: EngineRegistry,
    opts: { fetch?: typeof fetch } = {},
  ) {
    this.fetchImpl = opts.fetch;
  }

  add(cfg: CloudProviderConfig): void {
    const existing = this.configs.get(cfg.id);
    const normalized = normalizeProviderConfig({
      ...cfg,
      ...(cfg.apiKey === undefined && existing?.apiKey ? { apiKey: existing.apiKey } : {}),
      ...(cfg.headers === undefined && existing?.headers ? { headers: existing.headers } : {}),
    });
    this.remove(normalized.id);
    if (normalized.kind === "pi-native") {
      this.configs.set(normalized.id, normalized);
      return;
    }
    const baseUrl = normalized.baseUrl;
    if (!baseUrl) throw new Error("openai-compatible provider requires baseUrl");
    const engine = new OpenAICompatibleEngine({
      id: normalized.id,
      baseUrl,
      apiKey: normalized.apiKey,
      headers: normalized.headers,
      ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
    });
    this.registry.register(engine);
    for (const model of modelIdsForProvider(normalized)) this.registry.routeModel(model, engine);
    this.configs.set(normalized.id, normalized);
  }

  remove(id: string): void {
    const cfg = this.configs.get(id);
    if (!cfg) return;
    for (const model of modelIdsForProvider(cfg)) this.registry.unrouteModel(model);
    this.registry.unregister(id);
    this.configs.delete(id);
  }

  list(): {
    id: string;
    kind: CloudProviderKind;
    baseUrl?: string;
    api?: string;
    models: string[];
    modelConfigs: CloudProviderModelConfig[];
  }[] {
    return [...this.configs.values()].map((c) => ({
      id: c.id,
      kind: c.kind ?? "openai-compatible",
      ...(c.baseUrl ? { baseUrl: c.baseUrl } : {}),
      ...(c.api ? { api: c.api } : {}),
      models: modelIdsForProvider(c),
      modelConfigs: c.modelConfigs,
    }));
  }

  /** 当前配置暴露给 EasyWork 的模型 id（openai-compatible 与 pi-native 都包含）。 */
  modelIds(): string[] {
    return [...new Set([...this.configs.values()].flatMap((c) => modelIdsForProvider(c)))];
  }

  /** 每个云端模型 → 手动配置的上下文窗口（供 /models 的 context 映射、UI 进度环）。 */
  contexts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const c of this.configs.values()) {
      for (const m of c.modelConfigs) {
        out[m.id] = m.contextWindow;
      }
    }
    return out;
  }

  /** 完整配置（含 apiKey/headers），用于持久化恢复。 */
  dump(): CloudProviderConfig[] {
    return [...this.configs.values()];
  }

  /** 找到暴露了某 model id 的 provider 配置（供 pi-ai 解析云端模型）。 */
  findByModel(modelId: string): CloudProviderConfig | undefined {
    for (const c of this.configs.values()) if (c.modelConfigs.some((m) => m.id === modelId)) return c;
    return undefined;
  }
}

function normalizeProviderConfig(cfg: CloudProviderConfig): CloudProviderConfig & { kind: CloudProviderKind } {
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

export function modelConfigForModel(cfg: CloudProviderConfig, modelId: string): CloudProviderModelConfig | undefined {
  return cfg.modelConfigs?.find((m) => m.id === modelId);
}

export function contextWindowForModel(cfg: CloudProviderConfig, modelId: string): number | undefined {
  return modelConfigForModel(cfg, modelId)?.contextWindow
    ?? ((cfg.kind ?? "openai-compatible") === "pi-native"
      ? getPiModel(cfg.id as never, modelId as never)?.contextWindow
      : undefined);
}

export function inputModalitiesForModel(cfg: CloudProviderConfig, modelId: string): CloudProviderModelModality[] {
  return modelConfigForModel(cfg, modelId)?.inputModalities ?? ["text"];
}

function normalizeModelConfigs(configs: CloudProviderModelConfig[]): CloudProviderModelConfig[] {
  const out = new Map<string, CloudProviderModelConfig>();
  for (const cfg of configs) {
    const id = cfg.id.trim();
    if (!id) continue;
    const inputModalities = uniqueModalities(cfg.inputModalities);
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

function modelIdsForProvider(cfg: CloudProviderConfig): string[] {
  return cfg.modelConfigs.map((m) => m.id);
}

function uniqueModalities(modalities: CloudProviderModelModality[]): CloudProviderModelModality[] {
  const out = modalities.filter((m, index, all) => (m === "text" || m === "image") && all.indexOf(m) === index);
  return out.includes("text") ? out : ["text", ...out];
}
