import { z } from "zod";

/**
 * 记忆分层（均为全局、跨会话）。会话级历史已由 ConversationRepo 完整存档 + FTS5 全文检索
 * （session_search 工具）承载，不再有 session-summary 截断摘要层。
 */
export const MemoryLayerSchema = z.enum(["user-profile", "agent-memory", "skills"]);
export type MemoryLayer = z.infer<typeof MemoryLayerSchema>;

export const MemoryItemSchema = z.object({
  id: z.string(),
  layer: MemoryLayerSchema,
  text: z.string(),
  sessionId: z.string().optional(),
  score: z.number().optional(),
  updatedAt: z.string(),
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type MemoryItem = z.infer<typeof MemoryItemSchema>;

export const RecallQuerySchema = z.object({
  query: z.string(),
  sessionId: z.string().optional(),
  layers: z.array(MemoryLayerSchema).optional(),
  topK: z.number().int().positive().optional(),
  minScore: z.number().optional(),
});
export type RecallQuery = z.infer<typeof RecallQuerySchema>;

export const MemoryWriteSchema = MemoryItemSchema.omit({ id: true, updatedAt: true });
export type MemoryWrite = z.infer<typeof MemoryWriteSchema>;

/**
 * 可插拔记忆提供商接口。本地默认 = 分层 markdown + sqlite-vec 语义召回；
 * 外部如 Mem0/Supermemory 实现同一接口插入。
 */
export interface MemoryProvider {
  readonly id: string;
  recall(q: RecallQuery): Promise<MemoryItem[]>;
  write(item: MemoryWrite): Promise<MemoryItem>;
  edit(id: string, patch: Partial<Pick<MemoryItem, "text" | "meta">>): Promise<MemoryItem>;
  list(filter?: { layer?: MemoryLayer; sessionId?: string }): Promise<MemoryItem[]>;
  delete(id: string): Promise<void>;
  /**
   * 轮后抽取钩子：摘要 + 抽取持久事实，写入对应分层。
   * model 为当轮对话所用模型 id（已加载），实现可复用它做 LLM 事实抽取。
   */
  observe(input: { messages: unknown[]; sessionId: string; model?: string }): Promise<void>;
}
