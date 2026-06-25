import type { EmbedResult } from "@ew/shared";

/** 一个可启停、能 embed 的引擎（由 llama serve embedding 实例实现）。 */
export interface EmbedEngine {
  start(): Promise<void>;
  stop(): Promise<void>;
  embed(req: { model: string; input: string[] }): Promise<EmbedResult>;
}

export interface EmbeddingServiceDeps {
  /** 用给定模型路径创建一个 embedding 引擎（默认 = llama serve --embedding；测试可注入）。 */
  makeEngine: (modelPath: string) => EmbedEngine | Promise<EmbedEngine>;
}

/**
 * 本地 CPU embedding 服务（参考 Hermes：nomic-embed-text 语义召回）。
 * 经 `llama serve --embedding` 模式运行；未就绪时 embed 抛错 → 记忆降级词法。
 */
export class EmbeddingService {
  private engine?: EmbedEngine;
  private modelId?: string;
  private dim = 0;

  constructor(private readonly deps: EmbeddingServiceDeps) {}

  get ready(): boolean {
    return this.engine != null;
  }

  get info(): { ready: boolean; modelId?: string; dim: number } {
    return { ready: this.ready, ...(this.modelId ? { modelId: this.modelId } : {}), dim: this.dim };
  }

  /** 加载并设置 embedding 模型（启动 llama serve --embedding）。 */
  async setModel(modelPath: string): Promise<{ dim: number }> {
    await this.engine?.stop().catch(() => {});
    const engine = await this.deps.makeEngine(modelPath);
    await engine.start();
    this.engine = engine;
    this.modelId = modelPath;
    const probe = await engine.embed({ model: modelPath, input: ["probe"] });
    this.dim = probe.vectors[0]?.length ?? 0;
    return { dim: this.dim };
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!this.engine || !this.modelId) throw new Error("embedding 模型未就绪");
    const res = await this.engine.embed({ model: this.modelId, input: texts });
    return res.vectors;
  }

  async stop(): Promise<void> {
    await this.engine?.stop().catch(() => {});
    this.engine = undefined;
    this.modelId = undefined;
  }
}
