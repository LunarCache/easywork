import { OpenAICompatibleEngine } from "@ew/providers";
import type { EngineRegistry } from "../engine/registry.js";
import {
  modelIdsForProvider,
  normalizeProviderConfig,
  parseProviderModelRouteId,
  providerModelRouteId,
  routeIdsForProvider,
} from "./catalog.js";

export type CloudProviderKind = "openai-compatible" | "pi-native";
export type CloudProviderModelModality = "text" | "image";
export type CloudProviderCompatibilityMode = "auto" | "generic" | "catalog";

export interface CloudProviderCatalogRef {
  providerId: string;
  modelId: string;
}

export interface CloudProviderModelConfig {
  id: string;
  /** Per-model context window. */
  contextWindow: number;
  /** Per-model input modalities for custom compatible endpoints. */
  inputModalities: CloudProviderModelModality[];
  /** Optional explicit reasoning override. Omitted values inherit from catalogRef. */
  reasoning?: boolean;
  /** auto suggests a catalog model, generic disables inheritance, catalog pins catalogRef. */
  compatibilityMode?: CloudProviderCompatibilityMode;
  /** Reuse pi catalog model behavior while keeping this provider's endpoint and auth scope. */
  catalogRef?: CloudProviderCatalogRef;
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

export interface CloudProviderModelRef {
  config: CloudProviderConfig;
  /** EasyWork 内部使用的 provider-scoped route id。 */
  routeId: string;
  /** 发给上游 provider 的真实模型 id。 */
  modelId: string;
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
      mapModelId: (modelId) => {
        const parsed = parseProviderModelRouteId(modelId);
        return parsed?.providerId === normalized.id ? parsed.modelId : modelId;
      },
      ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
    });
    this.registry.register(engine);
    for (const model of routeIdsForProvider(normalized)) this.registry.routeModel(model, engine);
    this.configs.set(normalized.id, normalized);
  }

  remove(id: string): void {
    const cfg = this.configs.get(id);
    if (!cfg) return;
    for (const model of routeIdsForProvider(cfg)) this.registry.unrouteModel(model);
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

  /** 当前配置暴露给 EasyWork 的 provider-scoped 模型 id（openai-compatible 与 pi-native 都包含）。 */
  modelIds(): string[] {
    return [...new Set([...this.configs.values()].flatMap((c) => routeIdsForProvider(c)))];
  }

  /** 每个云端 route id → 手动配置的上下文窗口（供 /models 的 context 映射、UI 进度环）。 */
  contexts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const c of this.configs.values()) {
      for (const m of c.modelConfigs) {
        out[providerModelRouteId(c.id, m.id)] = m.contextWindow;
      }
    }
    return out;
  }

  /** 完整配置（含 apiKey/headers），用于持久化恢复。 */
  dump(): CloudProviderConfig[] {
    return [...this.configs.values()];
  }

  /** 找到暴露了某 route id / legacy raw model id 的 provider 配置（供旧调用点兼容）。 */
  findByModel(modelId: string): CloudProviderConfig | undefined {
    return this.resolveModelRef(modelId)?.config;
  }

  /** 解析 EasyWork route id → provider 配置 + 上游真实 model id。 */
  resolveModelRef(modelId: string): CloudProviderModelRef | undefined {
    const scoped = parseProviderModelRouteId(modelId);
    if (scoped) {
      const cfg = this.configs.get(scoped.providerId);
      if (cfg?.modelConfigs.some((m) => m.id === scoped.modelId)) {
        return { config: cfg, routeId: modelId, modelId: scoped.modelId };
      }
      return undefined;
    }
    // Legacy raw id fallback：老线程或外部 /v1 客户端仍可能直接传裸模型名。
    for (const c of this.configs.values()) {
      if (c.modelConfigs.some((m) => m.id === modelId)) {
        return { config: c, routeId: providerModelRouteId(c.id, modelId), modelId };
      }
    }
    return undefined;
  }
}
