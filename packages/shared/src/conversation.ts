import { z } from "zod";
import { ContentPartSchema, RoleSchema, ToolCallSchema } from "./message.js";
import { ChannelKindSchema } from "./im.js";
import { ToolResultSchema } from "./tool.js";

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  instructions: z.string().optional(),
  createdAt: z.string(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const ThreadSchema = z.object({
  id: z.string(),
  projectId: z.string().optional(),
  title: z.string(),
  channel: z
    .object({ kind: ChannelKindSchema, channelId: z.string() })
    .optional(),
  systemPrompt: z.string().optional(),
  modelId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Thread = z.infer<typeof ThreadSchema>;

export const StoredMessageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  role: RoleSchema,
  seq: z.number().int().nonnegative(),
  parts: z.array(ContentPartSchema),
  toolCalls: z.array(ToolCallSchema).optional(),
  toolResults: z.array(ToolResultSchema).optional(),
  createdAt: z.string(),
});
export type StoredMessage = z.infer<typeof StoredMessageSchema>;

/**
 * 会话仓库接口。跨渠道同一大脑的关键：
 * resolveThreadForChannel 把 (kind, channelUserId) 映射到稳定 thread。
 */
export interface ConversationRepo {
  createThread(t: Partial<Thread>): Thread;
  getThread(id: string): Thread | null;
  listThreads(filter?: { projectId?: string }): Thread[];
  appendMessage(m: StoredMessage): void;
  history(threadId: string, limit?: number): StoredMessage[];
  resolveThreadForChannel(
    kind: z.infer<typeof ChannelKindSchema>,
    channelUserId: string,
    opts?: { projectId?: string; modelId?: string },
  ): Thread;
}
