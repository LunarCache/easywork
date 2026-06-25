import { describe, it, expect } from "vitest";
import { EmbeddingService, type EmbedEngine } from "../src/memory/embedding-service.js";

/** 假 embedding 引擎（不起真实 llama.cpp）。 */
function fakeEngine(): EmbedEngine {
  return {
    async start() {},
    async stop() {},
    async embed(req) {
      return { vectors: req.input.map(() => [0.1, 0.2, 0.3]), model: req.model };
    },
  };
}

describe("EmbeddingService", () => {
  it("未就绪时 embed 抛错（→ 记忆降级词法）", async () => {
    const es = new EmbeddingService({ makeEngine: () => fakeEngine() });
    expect(es.ready).toBe(false);
    await expect(es.embed(["x"])).rejects.toThrow();
  });

  it("setModel 后就绪、探测维度、可批量 embed", async () => {
    const es = new EmbeddingService({ makeEngine: () => fakeEngine() });
    const { dim } = await es.setModel("/models/nomic.gguf");
    expect(dim).toBe(3);
    expect(es.ready).toBe(true);
    expect(es.info.modelId).toBe("/models/nomic.gguf");
    expect(await es.embed(["a", "b"])).toEqual([
      [0.1, 0.2, 0.3],
      [0.1, 0.2, 0.3],
    ]);
  });

  it("makeEngine 支持异步（真实实现里要分配端口）", async () => {
    const es = new EmbeddingService({ makeEngine: async () => fakeEngine() });
    const { dim } = await es.setModel("/m.gguf");
    expect(dim).toBe(3);
  });
});
