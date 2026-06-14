import { z } from "zod";
import { ChatMessageSchema, ToolCallSchema } from "./message.js";
import { ToolResultSchema } from "./tool.js";
import { UsageSchema } from "./provider.js";

/**
 * Agent 运行对外发出的事件（agent loop → UI / IM 连接器 / SSE）。
 * 渠道无关：loop 只认 threadId，发 AgentEvent，由各客户端渲染。
 */
export const AgentEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("reasoning"), text: z.string() }),
  z.object({ type: z.literal("tool-start"), call: ToolCallSchema }),
  z.object({ type: z.literal("tool-end"), call: ToolCallSchema, result: ToolResultSchema }),
  z.object({
    type: z.literal("approval-request"),
    id: z.string(),
    toolName: z.string(),
    args: z.unknown(),
  }),
  z.object({ type: z.literal("memory-recall"), count: z.number().int().nonnegative() }),
  z.object({ type: z.literal("usage"), usage: UsageSchema }),
  z.object({ type: z.literal("final"), message: ChatMessageSchema }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;

/** Agent 运行输入。 */
/** 采样参数（透传给推理引擎；本地 llama-server 支持 top_k/min_p/repeat_penalty 扩展字段）。 */
export interface SamplingParams {
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  repeatPenalty?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  maxTokens?: number;
  seed?: number;
  reasoningEffort?: "low" | "medium" | "high";
}

export const SamplingParamsSchema = z.object({
  temperature: z.number().min(0).optional(),
  topP: z.number().min(0).max(1).optional(),
  topK: z.number().int().nonnegative().optional(),
  minP: z.number().min(0).max(1).optional(),
  repeatPenalty: z.number().min(0).optional(),
  frequencyPenalty: z.number().optional(),
  presencePenalty: z.number().optional(),
  maxTokens: z.number().int().positive().optional(),
  seed: z.number().int().optional(),
  reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
});

export interface AgentRunInput {
  threadId: string;
  model: string;
  /** 已有历史（不含本轮新消息时由 caller 负责拼装）。 */
  history: z.infer<typeof ChatMessageSchema>[];
  maxIterations?: number;
  /** 排除（不提供给模型）的工具名，例如未开「联网」时排除 web_search。 */
  excludeTools?: string[];
  /** 采样参数（透传给引擎）。 */
  sampling?: SamplingParams;
  signal?: AbortSignal;
}
