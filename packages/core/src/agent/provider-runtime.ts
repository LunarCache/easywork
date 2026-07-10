import path from "node:path";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { completeSimple, streamSimple } from "@earendil-works/pi-ai";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context as PiContext,
  Model,
} from "@earendil-works/pi-ai";
import type { LocalBackend } from "../engine/local-backend.js";
import {
  contextWindowForModel,
  runtimeModelForProviderConfig,
  runtimeModelsForProviderConfig,
} from "../providers/catalog.js";
import type { ProviderManager } from "../providers/manager.js";

interface AgentProviderRuntimeDeps {
  agentDir: string;
  local: LocalBackend;
  providers: ProviderManager;
}

interface CloudInferenceOptions {
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
}

/**
 * Agent Runtime 的 provider seam：集中 pi AuthStorage / ModelRegistry 对账、本地/云端模型解析、
 * 以及 /v1 云端流式/非流式调用。SessionHost 只保留会话生命周期与单轮编排。
 */
export class AgentProviderRuntime {
  readonly authStorage: AuthStorage;
  readonly modelRegistry: ModelRegistry;

  private readonly registeredProviders = new Set<string>();
  private readonly managedAuthProviders = new Set<string>();
  private cloudRevision = 0;

  constructor(private readonly deps: AgentProviderRuntimeDeps) {
    this.authStorage = AuthStorage.create(path.join(deps.agentDir, "auth.json"));
    // llama 忽略 key，仅为通过 pi 的 provider key 校验。
    this.authStorage.set("local", { type: "api_key", key: "local" });
    this.modelRegistry = ModelRegistry.create(this.authStorage, path.join(deps.agentDir, "models.json"));
    this.syncCloudProviders();
  }

  /**
   * 把 EasyWork 云端 provider 同步进 pi（AuthStorage key + ModelRegistry provider/headers）。
   * 幂等 + 全量对账：已删除的 provider 会被注销。provider 增删后调用。
   */
  syncCloudProviders(): void {
    const present = new Set<string>();
    for (const cfg of this.deps.providers.dump()) {
      present.add(cfg.id);
      if (cfg.apiKey) {
        this.authStorage.set(cfg.id, { type: "api_key", key: cfg.apiKey });
        this.managedAuthProviders.add(cfg.id);
      }
      if ((cfg.kind ?? "openai-compatible") === "pi-native") {
        if (cfg.baseUrl || cfg.headers) {
          this.modelRegistry.registerProvider(cfg.id, {
            ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
            ...(cfg.headers ? { headers: cfg.headers } : {}),
            authHeader: true,
          });
        }
      } else {
        this.modelRegistry.registerProvider(cfg.id, {
          baseUrl: cfg.baseUrl,
          ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
          ...(cfg.headers ? { headers: cfg.headers } : {}),
          api: cfg.api ?? "openai-completions",
          authHeader: true,
          models: runtimeModelsForProviderConfig(cfg),
        });
      }
      this.registeredProviders.add(cfg.id);
    }
    for (const id of [...this.registeredProviders]) {
      if (present.has(id)) continue;
      this.modelRegistry.unregisterProvider(id);
      if (this.managedAuthProviders.has(id)) {
        this.authStorage.remove(id);
        this.managedAuthProviders.delete(id);
      }
      this.registeredProviders.delete(id);
    }
    this.cloudRevision += 1;
  }

  /** Cloud provider 配置版本；仅云端模型参与 SessionHost 的惰性会话重建。 */
  modelRevision(modelId: string): number {
    return this.deps.providers.resolveModelRef(modelId) ? this.cloudRevision : 0;
  }

  isLocalModel(modelId: string): boolean {
    return !!this.deps.local.baseUrlFor(modelId);
  }

  /** 解析一个 EasyWork modelId → pi `Model`（本地 llama / 云端 provider）。 */
  resolveModel(modelId: string): Model<Api> {
    const localBase = this.deps.local.baseUrlFor(modelId);
    if (localBase) {
      // llama 设了 --api-key 时（0.0.0.0 暴露），pi 调用本机也需带该 key。
      const key = this.deps.local.getApiKey?.() || "local";
      this.authStorage.set("local", { type: "api_key", key });
      const ctx = this.deps.local.contexts()[modelId];
      return {
        id: modelId,
        name: modelId,
        api: "openai-completions",
        provider: "local",
        baseUrl: localBase,
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: ctx && ctx > 0 ? ctx : 8192,
        maxTokens: 4096,
      };
    }
    const ref = this.deps.providers.resolveModelRef(modelId);
    if (ref) {
      const cfg = ref.config;
      const upstreamModelId = ref.modelId;
      if (!this.registeredProviders.has(cfg.id)) this.syncCloudProviders();
      const m = this.modelRegistry.find(cfg.id, upstreamModelId);
      if (m) {
        const ctx = contextWindowForModel(cfg, upstreamModelId);
        return {
          ...m,
          ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
          ...(ctx ? { contextWindow: ctx } : {}),
          ...(cfg.headers ? { headers: cfg.headers } : {}),
        };
      }
      if ((cfg.kind ?? "openai-compatible") === "pi-native") {
        throw new Error(`pi_native_model_not_found: ${cfg.id}/${upstreamModelId}`);
      }
      // registry 未命中（理论不应发生）→ 手搓兜底，带上 headers，鉴权由共享 AuthStorage 提供。
      return {
        ...runtimeModelForProviderConfig(cfg, upstreamModelId),
        api: cfg.api ?? "openai-completions",
        provider: cfg.id,
        baseUrl: cfg.baseUrl ?? "",
      };
    }
    throw new Error(`model_not_resolvable: ${modelId}`);
  }

  /**
   * 云端模型经 pi-ai 流式推理。非云端模型返回 null（由调用方回退）。
   */
  async streamCloud(
    modelId: string,
    context: PiContext,
    opts: CloudInferenceOptions = {},
  ): Promise<AssistantMessageEventStream | null> {
    const ref = this.deps.providers.resolveModelRef(modelId);
    const cfg = ref?.config;
    if (!cfg) return null;
    if (!this.registeredProviders.has(cfg.id)) this.syncCloudProviders();
    const model = this.resolveModel(modelId);
    const auth = await this.modelRegistry.getApiKeyAndHeaders(model);
    return streamSimple(model, context, this.streamOpts(auth, opts));
  }

  /** 云端非流式（completeSimple）：与 streamCloud 同源。非云端返回 null。 */
  async completeCloud(
    modelId: string,
    context: PiContext,
    opts: CloudInferenceOptions = {},
  ): Promise<AssistantMessage | null> {
    const ref = this.deps.providers.resolveModelRef(modelId);
    const cfg = ref?.config;
    if (!cfg) return null;
    if (!this.registeredProviders.has(cfg.id)) this.syncCloudProviders();
    const model = this.resolveModel(modelId);
    const auth = await this.modelRegistry.getApiKeyAndHeaders(model);
    return completeSimple(model, context, this.streamOpts(auth, opts));
  }

  private streamOpts(
    auth: Awaited<ReturnType<ModelRegistry["getApiKeyAndHeaders"]>>,
    opts: CloudInferenceOptions,
  ): Record<string, unknown> {
    return {
      ...(auth.ok && auth.apiKey ? { apiKey: auth.apiKey } : {}),
      ...(auth.ok && auth.headers ? { headers: auth.headers } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
      ...(opts.maxTokens != null ? { maxTokens: opts.maxTokens } : {}),
    };
  }
}
