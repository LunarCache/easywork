import { z } from "zod";

/** 会话角色。OpenAI-shaped 通用语言。 */
export const RoleSchema = z.enum(["system", "user", "assistant", "tool"]);
export type Role = z.infer<typeof RoleSchema>;

/** 多模态内容片段。string 是 [{type:"text"}] 的语法糖。 */
export const ContentPartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("image"),
    mimeType: z.string(),
    /** base64 数据 或 远程/本地 url。 */
    data: z.union([z.string(), z.object({ url: z.string() })]),
  }),
  z.object({ type: z.literal("audio"), mimeType: z.string(), data: z.string() }),
  z.object({
    type: z.literal("file"),
    mimeType: z.string(),
    name: z.string(),
    data: z.string(),
  }),
]);
export type ContentPart = z.infer<typeof ContentPartSchema>;

/**
 * 模型请求的一次工具调用。
 * arguments 始终是**原始 JSON 字符串**，绝不预解析 —— 模型常吐坏 JSON，
 * 解析在 agent loop 里带 try 进行，失败作为 tool 错误喂回。
 */
export const ToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  arguments: z.string(),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const ChatMessageSchema = z.object({
  role: RoleSchema,
  /** string 等价于单个 text part。 */
  content: z.union([z.string(), z.array(ContentPartSchema)]),
  name: z.string().optional(),
  /** 仅 assistant：本轮发起的工具调用。 */
  toolCalls: z.array(ToolCallSchema).optional(),
  /** 仅 tool 消息：对应的工具调用 id。 */
  toolCallId: z.string().optional(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

/** 把 content 归一化为 ContentPart[]（string → 单 text part）。 */
export function normalizeContent(content: ChatMessage["content"]): ContentPart[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content;
}

/** 提取一条消息的纯文本（拼接所有 text part）。 */
export function messageText(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("");
}
