import type { InferenceEngine } from "@ew/shared";

/**
 * 引擎注册表。agent loop / 路由只依赖这一层。
 * - 按 engine.id 注册引擎；
 * - 按 model id 路由到具体引擎（本地模型 load 后登记；云端模型在阶段 A 由 provider 登记）。
 */
export class EngineRegistry {
  private readonly engines = new Map<string, InferenceEngine>();
  private readonly modelRoute = new Map<string, InferenceEngine>();

  register(engine: InferenceEngine): void {
    this.engines.set(engine.id, engine);
  }

  unregister(engineId: string): void {
    this.engines.delete(engineId);
  }

  get(engineId: string): InferenceEngine | undefined {
    return this.engines.get(engineId);
  }

  list(): InferenceEngine[] {
    return [...this.engines.values()];
  }

  /** 把一个 model id 路由到某引擎。 */
  routeModel(modelId: string, engine: InferenceEngine): void {
    this.modelRoute.set(modelId, engine);
  }

  unrouteModel(modelId: string): void {
    this.modelRoute.delete(modelId);
  }

  /** 解析 model id 对应的引擎。 */
  resolve(modelId: string): InferenceEngine {
    const engine = this.modelRoute.get(modelId);
    if (!engine) throw new Error(`没有引擎可服务模型: ${modelId}`);
    return engine;
  }

  routedModels(): string[] {
    return [...this.modelRoute.keys()];
  }
}
