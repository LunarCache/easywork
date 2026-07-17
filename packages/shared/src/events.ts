import { z } from "zod";
import { ChatMessageSchema, ToolCallSchema } from "./message.js";
import { ToolResultSchema } from "./tool.js";
import { UsageSchema } from "./provider.js";
import { ChannelKindSchema } from "./im.js";
import { TurnArtifactSchema } from "./conversation.js";

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
    type: z.literal("tool-progress"),
    callId: z.string(),
    stream: z.enum(["stdout", "stderr"]),
    chunk: z.string(),
  }),
  z.object({
    type: z.literal("approval-request"),
    id: z.string(),
    toolCallId: z.string(),
    toolName: z.string(),
    args: z.unknown(),
  }),
  z.object({ type: z.literal("memory-recall"), count: z.number().int().nonnegative() }),
  z.object({ type: z.literal("usage"), usage: UsageSchema }),
  z.object({ type: z.literal("artifacts"), artifacts: z.array(TurnArtifactSchema) }),
  // 自动重试（provider 抖动时 pi 自带退避重试）：attempt/maxAttempts 从 1 计。
  z.object({
    type: z.literal("retry"),
    attempt: z.number().int().positive(),
    maxAttempts: z.number().int().positive(),
    delayMs: z.number().int().nonnegative().optional(),
    message: z.string().optional(),
  }),
  // 上下文压缩（自动阈值 / 溢出 / 手动）：phase=start|end；ok=false 表示压缩中止/失败（end 时）。
  z.object({
    type: z.literal("compaction"),
    phase: z.enum(["start", "end"]),
    reason: z.string().optional(),
    ok: z.boolean().optional(),
    tokensBefore: z.number().int().nonnegative().optional(),
    tokensAfter: z.number().int().nonnegative().optional(),
  }),
  z.object({ type: z.literal("final"), message: ChatMessageSchema }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;

/** 收件箱轻量失效事件：只通知客户端重新读取对应 read model，不承载消息正文。 */
export const InboxEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), at: z.string() }),
  z.object({
    type: z.literal("changed"),
    reason: z.enum(["message", "status", "connector"]),
    at: z.string(),
    threadId: z.string().optional(),
    channel: z.object({ kind: ChannelKindSchema, channelId: z.string() }).optional(),
  }),
]);
export type InboxEvent = z.infer<typeof InboxEventSchema>;

/** 思考档位（对外 4 档；映射到 pi 的 ThinkingLevel off/low/medium/high）。 */
export const ThinkLevelSchema = z.enum(["off", "low", "medium", "high"]);
export type ThinkLevel = z.infer<typeof ThinkLevelSchema>;

/** Agent 运行输入。 */
/** 采样参数（透传给推理引擎；本地 llama.cpp 支持 top_k/min_p/repeat_penalty 扩展字段）。 */
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
  /** 排除（不提供给模型）的工具名，例如未开「联网」时排除 explore_web。 */
  excludeTools?: string[];
  /** 采样参数（透传给引擎）。 */
  sampling?: SamplingParams;
  signal?: AbortSignal;
}
