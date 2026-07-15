import { OpenAICompatibleEngine } from "@ew/providers";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { EngineRegistry } from "../engine/registry.js";
import {
  ProviderModelConfiguration,
  type ConfiguredProviderModel,
} from "./model-configuration.js";

export type CloudProviderKind = "openai-compatible" | "pi-native";
export type CloudProviderModelModality = "text" | "image";
export type CloudProviderCompatibilityMode = "auto" | "generic" | "catalog";

export interface CloudProviderCatalogRef {
  providerId: string;
  modelId: string;
}

export interface CloudProviderConnectionConfig {
  id: string;
  api?: string;
  baseUrl?: string;
}

export interface CloudProviderModelConfig {
  id: string;
  /** Optional per-model API family override; falls back to the provider-level api. */
  api?: string;
  /** Optional per-model endpoint override for providers that mix wire protocols. */
  baseUrl?: string;
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
  /** Saved connection presets used by the model configuration UI; runtime models keep inline overrides. */
  connections?: CloudProviderConnectionConfig[];
  /** Per-model metadata. Model ids used for routing are derived from this list. */
  modelConfigs: CloudProviderModelConfig[];
}

export interface CloudProviderModelRef {
  config: CloudProviderConfig;
  /** EasyWork 内部使用的 provider-scoped route id。 */
  routeId: string;
  /** 发给上游 provider 的真实模型 id。 */
  modelId: string;
  /** Core 唯一语义模块产出的最终 pi runtime model。 */
  runtimeModel: Model<Api>;
}

export interface CloudProviderModelProjection {
  config: CloudProviderConfig;
  routeId: string;
  modelId: string;
  contextWindow: number;
  reasoning: boolean;
}

/**
 * 云端 provider 管理：把 OpenAI 兼容 provider 注册为引擎并把其模型路由进 EngineRegistry。
 * MVP 阶段配置存内存；阶段 C 接 SQLite + keychain 持久化密钥。
 */
export class ProviderManager {
  private readonly configs = new Map<string, CloudProviderConfig>();
  private readonly fetchImpl?: typeof fetch;
  private readonly modelConfiguration: ProviderModelConfiguration;

  constructor(
    private readonly registry: EngineRegistry,
    opts: { fetch?: typeof fetch; modelConfiguration?: ProviderModelConfiguration } = {},
  ) {
    this.fetchImpl = opts.fetch;
    this.modelConfiguration = opts.modelConfiguration ?? new ProviderModelConfiguration();
  }

  add(cfg: CloudProviderConfig): void {
    const existing = this.configs.get(cfg.id);
    const normalized = this.modelConfiguration.normalize({
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
        const parsed = this.modelConfiguration.parseRouteId(modelId);
        return parsed?.providerId === normalized.id ? parsed.modelId : modelId;
      },
      ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
    });
    this.registry.register(engine);
    for (const model of this.modelConfiguration.models(normalized)) this.registry.routeModel(model.routeId, engine);
    this.configs.set(normalized.id, normalized);
  }

  remove(id: string): void {
    const cfg = this.configs.get(id);
    if (!cfg) return;
    for (const model of this.modelConfiguration.identities(cfg)) this.registry.unrouteModel(model.routeId);
    this.registry.unregister(id);
    this.configs.delete(id);
  }

  list(): {
    id: string;
    kind: CloudProviderKind;
    baseUrl?: string;
    api?: string;
    connections?: CloudProviderConnectionConfig[];
    models: string[];
    modelConfigs: CloudProviderModelConfig[];
  }[] {
    return [...this.configs.values()].map((c) => ({
      id: c.id,
      kind: c.kind ?? "openai-compatible",
      ...(c.baseUrl ? { baseUrl: c.baseUrl } : {}),
      ...(c.api ? { api: c.api } : {}),
      ...(c.connections?.length ? { connections: c.connections } : {}),
      models: c.modelConfigs.map((model) => model.id),
      modelConfigs: c.modelConfigs,
    }));
  }

  /** 当前配置暴露给 EasyWork 的 provider-scoped 模型 id（openai-compatible 与 pi-native 都包含）。 */
  modelIds(): string[] {
    return [...new Set([...this.configs.values()].flatMap((config) =>
      this.modelConfiguration.identities(config).map((model) => model.routeId)))];
  }

  /** 每个云端 route id → 手动配置的上下文窗口（供 /models 的 context 映射、UI 进度环）。 */
  contexts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const model of this.modelProjections()) {
      out[model.routeId] = model.contextWindow;
    }
    return out;
  }

  /** 完整配置（含 apiKey/headers），用于持久化恢复。 */
  dump(): CloudProviderConfig[] {
    return [...this.configs.values()];
  }

  /** 找到暴露了某 route id / legacy raw model id 的 provider 配置（供旧调用点兼容）。 */
  findByModel(modelId: string): CloudProviderConfig | undefined {
    const scoped = this.modelConfiguration.parseRouteId(modelId);
    if (scoped) {
      const cfg = this.configs.get(scoped.providerId);
      return cfg && this.modelConfiguration.identities(cfg).some(
        (model) => model.upstreamModelId === scoped.modelId,
      )
        ? cfg
        : undefined;
    }
    for (const cfg of this.configs.values()) {
      if (this.modelConfiguration.identities(cfg).some((model) => model.upstreamModelId === modelId)) {
        return cfg;
      }
    }
    return undefined;
  }

  /** 解析 EasyWork route id → provider 配置 + 上游真实 model id。 */
  resolveModelRef(modelId: string): CloudProviderModelRef | undefined {
    const scoped = this.modelConfiguration.parseRouteId(modelId);
    if (scoped) {
      const cfg = this.configs.get(scoped.providerId);
      if (!cfg) return undefined;
      const resolved = this.modelConfiguration.resolve(cfg, modelId);
      return resolved ? this.modelRef(cfg, resolved) : undefined;
    }
    // Legacy raw id fallback：老线程或外部 /v1 客户端仍可能直接传裸模型名。
    for (const c of this.configs.values()) {
      const resolved = this.modelConfiguration.resolve(c, modelId);
      if (resolved) return this.modelRef(c, resolved);
    }
    return undefined;
  }

  runtimeModels(providerId: string): Model<Api>[] {
    const cfg = this.configs.get(providerId);
    return cfg ? this.modelConfiguration.models(cfg).map((model) => model.runtimeModel) : [];
  }

  modelRefs(): CloudProviderModelRef[] {
    return [...this.configs.values()].flatMap((config) =>
      this.modelConfiguration.models(config).map((model) => this.modelRef(config, model)));
  }

  modelProjections(): CloudProviderModelProjection[] {
    return [...this.configs.values()].flatMap((config) =>
      this.modelConfiguration.projections(config).map((model) => ({
        config,
        routeId: model.routeId,
        modelId: model.upstreamModelId,
        contextWindow: model.contextWindow,
        reasoning: model.reasoning,
      })));
  }

  private modelRef(config: CloudProviderConfig, model: ConfiguredProviderModel): CloudProviderModelRef {
    return {
      config,
      routeId: model.routeId,
      modelId: model.upstreamModelId,
      runtimeModel: model.runtimeModel,
    };
  }
}
