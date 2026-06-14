import { z } from "zod";
import { ChatMessageSchema, type ChatMessage } from "./message.js";
import { ToolDefinitionSchema } from "./tool.js";

/** 引擎能力标志。本地 GGUF 多数 nativeToolCalls=false → 走自愈解析器。 */
export const EngineCapabilitiesSchema = z.object({
  streaming: z.boolean(),
  nativeToolCalls: z.boolean(),
  vision: z.boolean(),
  audio: z.boolean(),
  embeddings: z.boolean(),
  jsonSchema: z.boolean(),
  maxContext: z.number().int().positive().optional(),
});
export type EngineCapabilities = z.infer<typeof EngineCapabilitiesSchema>;

export const ToolChoiceSchema = z.union([
  z.enum(["auto", "none", "required"]),
  z.object({ name: z.string() }),
]);
export type ToolChoice = z.infer<typeof ToolChoiceSchema>;

export const ResponseFormatSchema = z.object({
  type: z.enum(["text", "json_object", "json_schema"]),
  schema: z.record(z.string(), z.unknown()).optional(),
});

/** 引擎无关的对话补全请求。 */
export const ChatRequestSchema = z.object({
  model: z.string(),
  messages: z.array(ChatMessageSchema),
  tools: z.array(ToolDefinitionSchema).optional(),
  toolChoice: ToolChoiceSchema.optional(),
  temperature: z.number().min(0).optional(),
  topP: z.number().min(0).max(1).optional(),
  topK: z.number().int().nonnegative().optional(),
  minP: z.number().min(0).max(1).optional(),
  repeatPenalty: z.number().min(0).optional(),
  frequencyPenalty: z.number().optional(),
  presencePenalty: z.number().optional(),
  maxTokens: z.number().int().positive().optional(),
  stop: z.array(z.string()).optional(),
  responseFormat: ResponseFormatSchema.optional(),
  seed: z.number().int().optional(),
  /** 思维努力档位（部分模型模板支持，如 gpt-oss / Qwen3）。 */
  reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema> & { signal?: AbortSignal };

export const FinishReasonSchema = z.enum([
  "stop",
  "length",
  "tool_calls",
  "content_filter",
  "aborted",
  "error",
]);
export type FinishReason = z.infer<typeof FinishReasonSchema>;

export const UsageSchema = z.object({
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
});
export type Usage = z.infer<typeof UsageSchema>;

export const ChatResponseSchema = z.object({
  message: ChatMessageSchema,
  finishReason: FinishReasonSchema,
  usage: UsageSchema.optional(),
  model: z.string(),
});
export type ChatResponse = z.infer<typeof ChatResponseSchema>;

/**
 * 流式事件（判别联合）。
 * 不用裸字符串流 —— 无法表达 text 与 tool call 交织。
 * text-delta 已剥离 tool 标记（非原生引擎在尾缓冲里 strip 后才发）。
 */
export const ChatStreamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text-delta"), text: z.string() }),
  z.object({ type: z.literal("reasoning-delta"), text: z.string() }),
  z.object({
    type: z.literal("tool-call-start"),
    index: z.number().int(),
    id: z.string(),
    name: z.string(),
  }),
  z.object({
    type: z.literal("tool-call-args-delta"),
    index: z.number().int(),
    delta: z.string(),
  }),
  z.object({ type: z.literal("tool-call-end"), index: z.number().int() }),
  z.object({ type: z.literal("usage"), usage: UsageSchema }),
  z.object({
    type: z.literal("done"),
    finishReason: FinishReasonSchema,
    message: ChatMessageSchema,
  }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type ChatStreamEvent = z.infer<typeof ChatStreamEventSchema>;

export const EmbedRequestSchema = z.object({
  model: z.string(),
  input: z.array(z.string()),
});
export type EmbedRequest = z.infer<typeof EmbedRequestSchema>;

export const EmbedResultSchema = z.object({
  vectors: z.array(z.array(z.number())),
  model: z.string(),
});
export type EmbedResult = z.infer<typeof EmbedResultSchema>;

/**
 * 统一推理引擎接口。本地（node-llama-cpp）与云端（OpenAI-兼容）都实现它。
 * 这是 agent loop 唯一依赖的抽象。
 */
export interface InferenceEngine {
  readonly id: string;
  readonly capabilities: EngineCapabilities;
  chat(req: ChatRequest): Promise<ChatResponse>;
  chatStream(req: ChatRequest): AsyncIterable<ChatStreamEvent>;
  countTokens?(messages: ChatMessage[], model: string): Promise<number>;
  embed?(req: EmbedRequest): Promise<EmbedResult>;
}
