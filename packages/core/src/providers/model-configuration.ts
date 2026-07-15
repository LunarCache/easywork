import {
  getModel as defaultGetPiModel,
  getProviders as defaultGetPiProviders,
  type Api,
  type Model,
  type OpenAICompletionsCompat,
} from "@earendil-works/pi-ai";
import type {
  CloudProviderConfig,
  CloudProviderKind,
  CloudProviderModelConfig,
  CloudProviderModelModality,
} from "./manager.js";

type PiProvider = ReturnType<typeof defaultGetPiProviders>[number];

export interface ProviderModelCatalogAdapter {
  providers(): string[];
  model(providerId: string, modelId: string): Model<Api> | undefined;
}

export interface ConfiguredProviderModel {
  routeId: string;
  upstreamModelId: string;
  runtimeModel: Model<Api>;
}

export interface ProviderModelIdentity {
  routeId: string;
  upstreamModelId: string;
}

export interface ProviderModelProjection extends ProviderModelIdentity {
  contextWindow: number;
  reasoning: boolean;
}

export type NormalizedCloudProviderConfig = CloudProviderConfig & { kind: CloudProviderKind };

export const DEFAULT_COMPATIBLE_CONTEXT_WINDOW = 32768;
const PROVIDER_MODEL_ROUTE_PREFIX = "provider:";
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const defaultCatalog: ProviderModelCatalogAdapter = {
  providers: () => defaultGetPiProviders(),
  model: (providerId, modelId) => defaultGetPiModel(
    providerId as PiProvider,
    modelId as never,
  ) as Model<Api> | undefined,
};

/**
 * Provider Model Configuration 的唯一语义所有者：从保存配置产生 route identity、
 * 上游 identity 与最终 pi runtime model。Catalog 是内部可替换 adapter。
 */
export class ProviderModelConfiguration {
  constructor(private readonly catalog: ProviderModelCatalogAdapter = defaultCatalog) {}

  normalize(cfg: CloudProviderConfig): NormalizedCloudProviderConfig {
    const kind = cfg.kind ?? "openai-compatible";
    if (kind === "openai-compatible" && !cfg.baseUrl) {
      throw new Error("openai-compatible provider requires baseUrl");
    }
    const modelConfigs = normalizeModelConfigs(cfg.modelConfigs);
    if (modelConfigs.length === 0) throw new Error("provider requires at least one modelConfig");
    return {
      ...cfg,
      kind,
      modelConfigs,
      ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl.replace(/\/$/, "") } : {}),
    };
  }

  models(cfg: CloudProviderConfig): ConfiguredProviderModel[] {
    const normalized = this.normalize(cfg);
    return normalized.modelConfigs.map((model) => this.configuredModel(normalized, model));
  }

  /** Route/list projection does not require a usable upstream runtime model. */
  identities(cfg: CloudProviderConfig): ProviderModelIdentity[] {
    const normalized = this.normalize(cfg);
    return normalized.modelConfigs.map((model) => this.identity(normalized.id, model.id));
  }

  /** UI/API projection remains available for stale native configs; actual runtime resolution fails closed. */
  projections(cfg: CloudProviderConfig): ProviderModelProjection[] {
    const normalized = this.normalize(cfg);
    return normalized.modelConfigs.map((model) => {
      const identity = this.identity(normalized.id, model.id);
      if (normalized.kind !== "pi-native") {
        const runtimeModel = this.configuredModel(normalized, model).runtimeModel;
        return { ...identity, contextWindow: runtimeModel.contextWindow, reasoning: runtimeModel.reasoning };
      }
      const template = this.catalogTemplate(normalized, model);
      return {
        ...identity,
        contextWindow: model.contextWindow,
        reasoning: model.reasoning ?? template?.reasoning ?? false,
      };
    });
  }

  resolve(cfg: CloudProviderConfig, requestedId: string): ConfiguredProviderModel | undefined {
    const normalized = this.normalize(cfg);
    const scoped = this.parseRouteId(requestedId);
    const upstreamModelId = scoped
      ? scoped.providerId === normalized.id ? scoped.modelId : undefined
      : requestedId;
    if (!upstreamModelId) return undefined;
    const model = normalized.modelConfigs.find((item) => item.id === upstreamModelId);
    return model ? this.configuredModel(normalized, model) : undefined;
  }

  routeId(providerId: string, modelId: string): string {
    return `${PROVIDER_MODEL_ROUTE_PREFIX}${encodeURIComponent(providerId)}:${encodeURIComponent(modelId)}`;
  }

  parseRouteId(id: string): { providerId: string; modelId: string } | undefined {
    if (!id.startsWith(PROVIDER_MODEL_ROUTE_PREFIX)) return undefined;
    const rest = id.slice(PROVIDER_MODEL_ROUTE_PREFIX.length);
    const separator = rest.indexOf(":");
    if (separator <= 0 || separator >= rest.length - 1) return undefined;
    try {
      return {
        providerId: decodeURIComponent(rest.slice(0, separator)),
        modelId: decodeURIComponent(rest.slice(separator + 1)),
      };
    } catch {
      return undefined;
    }
  }

  private identity(providerId: string, modelId: string): ProviderModelIdentity {
    return { routeId: this.routeId(providerId, modelId), upstreamModelId: modelId };
  }

  private configuredModel(
    cfg: NormalizedCloudProviderConfig,
    modelConfig: CloudProviderModelConfig,
  ): ConfiguredProviderModel {
    const template = this.catalogTemplate(cfg, modelConfig);
    const kind = cfg.kind ?? "openai-compatible";
    if (kind === "pi-native" && !template) {
      throw new Error(`pi_native_model_not_found: ${cfg.id}/${modelConfig.id}`);
    }
    const runtimeModel = kind === "pi-native"
      ? this.nativeRuntimeModel(cfg, modelConfig, template!)
      : this.compatibleRuntimeModel(cfg, modelConfig, template);
    return {
      routeId: this.routeId(cfg.id, modelConfig.id),
      upstreamModelId: modelConfig.id,
      runtimeModel,
    };
  }

  private compatibleRuntimeModel(
    cfg: NormalizedCloudProviderConfig,
    modelConfig: CloudProviderModelConfig,
    template: Model<Api> | undefined,
  ): Model<Api> {
    const api = (modelConfig.api ?? cfg.api ?? "openai-completions") as Api;
    const baseUrl = runtimeBaseUrlForApi(api, modelConfig.baseUrl ?? cfg.baseUrl ?? "");
    const inheritedCompat = template?.api === api ? materializeCatalogCompat(template) : undefined;
    const compat = api === "openai-completions"
      ? { ...SAFE_CUSTOM_OPENAI_COMPLETIONS_COMPAT, ...inheritedCompat }
      : inheritedCompat;
    return {
      id: modelConfig.id,
      name: template?.name ?? modelConfig.id,
      api,
      provider: cfg.id,
      baseUrl,
      reasoning: modelConfig.reasoning ?? template?.reasoning ?? false,
      ...(template?.thinkingLevelMap ? { thinkingLevelMap: template.thinkingLevelMap } : {}),
      input: normalizeModalities(modelConfig.inputModalities),
      cost: ZERO_COST,
      contextWindow: modelConfig.contextWindow ?? DEFAULT_COMPATIBLE_CONTEXT_WINDOW,
      maxTokens: template?.maxTokens ?? 4096,
      ...(cfg.headers ? { headers: cfg.headers } : {}),
      ...(compat ? { compat } : {}),
    } as Model<Api>;
  }

  private nativeRuntimeModel(
    cfg: NormalizedCloudProviderConfig,
    modelConfig: CloudProviderModelConfig,
    template: Model<Api>,
  ): Model<Api> {
    return {
      ...template,
      reasoning: modelConfig.reasoning ?? template.reasoning,
      input: normalizeModalities(modelConfig.inputModalities),
      contextWindow: modelConfig.contextWindow,
      ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
      ...(cfg.headers ? { headers: cfg.headers } : {}),
    } as Model<Api>;
  }

  private catalogTemplate(
    cfg: NormalizedCloudProviderConfig,
    modelConfig: CloudProviderModelConfig,
  ): Model<Api> | undefined {
    // pi-native 的协议身份只能来自 pi catalog；legacy compatibilityMode 不得改变 wire protocol。
    if (cfg.kind === "pi-native") return this.catalog.model(cfg.id, modelConfig.id);
    const mode = modelConfig.compatibilityMode ?? "auto";
    if (mode === "generic") return undefined;
    const ref = modelConfig.catalogRef;
    if (mode === "catalog") return ref ? this.catalog.model(ref.providerId, ref.modelId) : undefined;

    const candidates = this.catalog.providers()
      .map((providerId) => this.catalog.model(providerId, modelConfig.id))
      .filter((model): model is Model<Api> => !!model);
    const lowerId = modelConfig.id.toLowerCase();
    return candidates.find((model) => lowerId.startsWith(model.provider.toLowerCase()))
      ?? (candidates.length === 1 ? candidates[0] : undefined);
  }
}

/** pi-ai's Anthropic client appends `/v1/messages`; accept user-facing API roots ending in `/v1`. */
function runtimeBaseUrlForApi(api: Api, baseUrl: string): string {
  if (api !== "anthropic-messages") return baseUrl;
  return baseUrl.replace(/\/v1(?:\/messages)?$/, "");
}

const defaultConfiguration = new ProviderModelConfiguration();

/**
 * Compatibility facade for existing `@ew/core` imports. These helpers delegate to the
 * deep module and remain until a major-version migration can remove the public surface.
 */

export function normalizeProviderConfig(cfg: CloudProviderConfig): NormalizedCloudProviderConfig {
  return defaultConfiguration.normalize(cfg);
}

export function providerModelRouteId(providerId: string, modelId: string): string {
  return defaultConfiguration.routeId(providerId, modelId);
}

export function parseProviderModelRouteId(id: string): { providerId: string; modelId: string } | undefined {
  return defaultConfiguration.parseRouteId(id);
}

export function modelIdsForProvider(cfg: CloudProviderConfig): string[] {
  return defaultConfiguration.normalize(cfg).modelConfigs.map((model) => model.id);
}

export function routeIdsForProvider(cfg: CloudProviderConfig): string[] {
  return defaultConfiguration.identities(cfg).map((model) => model.routeId);
}

export function modelConfigForModel(
  cfg: CloudProviderConfig,
  modelId: string,
): CloudProviderModelConfig | undefined {
  return defaultConfiguration.normalize(cfg).modelConfigs.find((model) => model.id === modelId);
}

export function contextWindowForModel(cfg: CloudProviderConfig, modelId: string): number | undefined {
  return modelConfigForModel(cfg, modelId)?.contextWindow;
}

export function inputModalitiesForModel(
  cfg: CloudProviderConfig,
  modelId: string,
): CloudProviderModelModality[] {
  return modelConfigForModel(cfg, modelId)?.inputModalities ?? ["text"];
}

export function runtimeModelsForProviderConfig(cfg: CloudProviderConfig): Model<Api>[] {
  return defaultConfiguration.models(cfg).map((model) => model.runtimeModel);
}

export function runtimeModelForProviderConfig(cfg: CloudProviderConfig, modelId: string): Model<Api> {
  const resolved = defaultConfiguration.resolve(cfg, modelId);
  if (!resolved) throw new Error(`provider_model_not_found: ${cfg.id}/${modelId}`);
  return resolved.runtimeModel;
}

function normalizeModelConfigs(configs: CloudProviderModelConfig[]): CloudProviderModelConfig[] {
  const out = new Map<string, CloudProviderModelConfig>();
  for (const cfg of configs) {
    const id = cfg.id.trim();
    if (!id) continue;
    const contextWindow = Math.floor(cfg.contextWindow);
    if (!Number.isFinite(contextWindow) || contextWindow <= 0) continue;
    out.set(id, {
      id,
      ...(cfg.api?.trim() ? { api: cfg.api.trim() } : {}),
      ...(cfg.baseUrl?.trim() ? { baseUrl: cfg.baseUrl.trim().replace(/\/$/, "") } : {}),
      contextWindow,
      inputModalities: normalizeModalities(cfg.inputModalities),
      ...(cfg.reasoning !== undefined ? { reasoning: cfg.reasoning } : {}),
      ...(cfg.compatibilityMode ? { compatibilityMode: cfg.compatibilityMode } : {}),
      ...(cfg.catalogRef?.providerId.trim() && cfg.catalogRef.modelId.trim() ? {
        catalogRef: {
          providerId: cfg.catalogRef.providerId.trim(),
          modelId: cfg.catalogRef.modelId.trim(),
        },
      } : {}),
    });
  }
  return [...out.values()];
}

const SAFE_CUSTOM_OPENAI_COMPLETIONS_COMPAT: OpenAICompletionsCompat = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  maxTokensField: "max_tokens",
  supportsStrictMode: false,
  supportsLongCacheRetention: false,
};

function normalizeModalities(values: readonly string[] | undefined): CloudProviderModelModality[] {
  const out = (values ?? []).filter((modality, index, all): modality is CloudProviderModelModality =>
    (modality === "text" || modality === "image") && all.indexOf(modality) === index);
  return out.includes("text") ? out : ["text", ...out];
}

function materializeCatalogCompat(template: Model<Api>): Model<Api>["compat"] {
  if (template.api !== "openai-completions") return template.compat;
  const compat = { ...template.compat } as OpenAICompletionsCompat;
  if (compat.supportsDeveloperRole === undefined) {
    compat.supportsDeveloperRole = catalogTemplateSupportsDeveloperRole(template);
  }
  return compat;
}

const CATALOG_PROVIDERS_WITHOUT_DEVELOPER_ROLE = new Set([
  "ant-ling", "cerebras", "chutes", "cloudflare-ai-gateway", "cloudflare-workers-ai",
  "deepseek", "moonshotai", "moonshotai-cn", "nvidia", "opencode", "opencode-go",
  "together", "xai", "zai", "zai-coding-cn",
]);

function catalogTemplateSupportsDeveloperRole(template: Model<Api>): boolean {
  if (template.provider === "openrouter") {
    return template.id.startsWith("anthropic/") || template.id.startsWith("openai/");
  }
  return !CATALOG_PROVIDERS_WITHOUT_DEVELOPER_ROLE.has(template.provider);
}
