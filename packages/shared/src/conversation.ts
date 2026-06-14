import { z } from "zod";
import { ContentPartSchema, RoleSchema, ToolCallSchema } from "./message.js";
import { ChannelKindSchema } from "./im.js";
import { ToolResultSchema } from "./tool.js";

/** 工作区审批模式：决定 fs 写 / 命令执行是否需逐次批准。 */
export const ApprovalModeSchema = z.enum(["read-only", "approve-each", "auto-edits", "full-auto"]);
export type ApprovalMode = z.infer<typeof ApprovalModeSchema>;

/**
 * 项目 = 工作区。workspaceDir 为本地项目根绝对路径（存在则为工作区项目，agent 可在其中读写/执行）。
 * instructions 作为项目级系统提示注入（类 AGENTS.md）。
 */
export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  instructions: z.string().optional(),
  workspaceDir: z.string().optional(),
  approvalMode: ApprovalModeSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
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

/** 会话全文搜索命中（FTS5）：定位历史消息 + 高亮片段。 */
export const MessageSearchHitSchema = z.object({
  threadId: z.string(),
  threadTitle: z.string(),
  messageId: z.string(),
  role: RoleSchema,
  seq: z.number().int().nonnegative(),
  /** 高亮片段（命中词以 [ ] 包裹）。 */
  snippet: z.string(),
  createdAt: z.string(),
});
export type MessageSearchHit = z.infer<typeof MessageSearchHitSchema>;

/**
 * 会话仓库接口。跨渠道同一大脑的关键：
 * resolveThreadForChannel 把 (kind, channelUserId) 映射到稳定 thread。
 */
export interface ConversationRepo {
  createProject(p: Partial<Project> & { name: string }): Project;
  getProject(id: string): Project | null;
  listProjects(): Project[];
  updateProject(
    id: string,
    patch: Partial<Pick<Project, "name" | "instructions" | "workspaceDir" | "approvalMode">>,
  ): Project;
  deleteProject(id: string): void;
  createThread(t: Partial<Thread>): Thread;
  getThread(id: string): Thread | null;
  listThreads(filter?: { projectId?: string }): Thread[];
  appendMessage(m: StoredMessage): void;
  history(threadId: string, limit?: number): StoredMessage[];
  /** 跨会话全文搜索消息（FTS5）。threadId 限定单会话。 */
  searchMessages(query: string, opts?: { limit?: number; threadId?: string }): MessageSearchHit[];
  resolveThreadForChannel(
    kind: z.infer<typeof ChannelKindSchema>,
    channelUserId: string,
    opts?: { projectId?: string; modelId?: string },
  ): Thread;
}
