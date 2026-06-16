// @ew/memory — 可插拔记忆提供商（本地默认 + 外部如 Mem0）。
export {
  LocalMemoryProvider,
  type LocalMemoryOptions,
  type Embedder,
  type ExtractedFact,
  type FactExtractor,
} from "./local.js";
export { Mem0MemoryProvider, type Mem0Options } from "./mem0.js";
export { cosine, lexicalScore } from "./cosine.js";
export { SqliteVecIndex, type VecRepopulate } from "./vec-index.js";
