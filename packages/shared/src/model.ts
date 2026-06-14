import { z } from "zod";

/** HuggingFace 模型摘要（搜索结果）。 */
export const HFModelSummarySchema = z.object({
  repoId: z.string(),
  author: z.string(),
  downloads: z.number().int().nonnegative(),
  likes: z.number().int().nonnegative(),
  tags: z.array(z.string()),
  hasGGUF: z.boolean(),
  updatedAt: z.string(),
});
export type HFModelSummary = z.infer<typeof HFModelSummarySchema>;

/** 一个逻辑 GGUF 变体（多分片归组为一个）。 */
export const GGUFVariantSchema = z.object({
  repoId: z.string(),
  fileName: z.string(),
  quant: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  shardCount: z.number().int().positive(),
  mmprojFile: z.string().optional(),
});
export type GGUFVariant = z.infer<typeof GGUFVariantSchema>;

export const ModelSourceSchema = z.enum(["downloaded", "scanned", "imported"]);

/** 本地已就绪模型。 */
export const LocalModelSchema = z.object({
  id: z.string(),
  repoId: z.string().optional(),
  path: z.string(),
  fileName: z.string(),
  quant: z.string().optional(),
  sizeBytes: z.number().int().nonnegative(),
  contextDefault: z.number().int().positive().optional(),
  arch: z.string().optional(),
  hasVision: z.boolean(),
  source: ModelSourceSchema,
  addedAt: z.string(),
});
export type LocalModel = z.infer<typeof LocalModelSchema>;

/** 下载进度事件。 */
export const DownloadEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("queued") }),
  z.object({
    type: z.literal("progress"),
    receivedBytes: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
    bytesPerSec: z.number().nonnegative(),
    etaSec: z.number().nonnegative(),
  }),
  z.object({ type: z.literal("shard"), index: z.number().int(), total: z.number().int() }),
  z.object({ type: z.literal("verifying") }),
  z.object({ type: z.literal("done"), model: LocalModelSchema }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type DownloadEvent = z.infer<typeof DownloadEventSchema>;

/** 本地引擎加载选项。 */
export const LocalLoadOptionsSchema = z.object({
  modelPath: z.string(),
  ggufVariant: z.string().optional(),
  contextSize: z.number().int().nonnegative().optional(),
  gpuLayers: z.union([z.number().int(), z.literal("auto")]).optional(),
  kvCacheType: z.enum(["f16", "q8_0", "q4_0"]).optional(),
  chatTemplateOverride: z.string().optional(),
  mmprojPath: z.string().optional(),
  embeddingMode: z.boolean().optional(),
});
export type LocalLoadOptions = z.infer<typeof LocalLoadOptionsSchema>;
