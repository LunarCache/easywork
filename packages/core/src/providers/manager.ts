import { OpenAICompatibleEngine } from "@ew/providers";
import type { EngineRegistry } from "../engine/registry.js";

export interface CloudProviderConfig {
  id: string;
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  /** 该 provider 暴露的模型 id 列表（用于路由 + /v1/models）。 */
  models: string[];
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
    const engine = new OpenAICompatibleEngine({
      id: cfg.id,
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      headers: cfg.headers,
      ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
    });
    this.registry.register(engine);
    for (const model of cfg.models) this.registry.routeModel(model, engine);
    this.configs.set(cfg.id, cfg);
  }

  remove(id: string): void {
    const cfg = this.configs.get(id);
    if (!cfg) return;
    for (const model of cfg.models) this.registry.unrouteModel(model);
    this.configs.delete(id);
  }

  list(): { id: string; baseUrl: string; models: string[] }[] {
    return [...this.configs.values()].map((c) => ({
      id: c.id,
      baseUrl: c.baseUrl,
      models: c.models,
    }));
  }

  /** 完整配置（含 apiKey/headers），用于持久化恢复。 */
  dump(): CloudProviderConfig[] {
    return [...this.configs.values()];
  }
}
