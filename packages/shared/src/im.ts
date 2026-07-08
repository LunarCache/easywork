import { z } from "zod";
import { ContentPartSchema } from "./message.js";

/** 渠道类型。inapp = 应用内聊天；其余为外部 IM。 */
export const ChannelKindSchema = z.enum([
  "inapp",
  "telegram",
  "discord",
  "wecom",
  "feishu",
  "wechat",
]);
export type ChannelKind = z.infer<typeof ChannelKindSchema>;

export const ChannelChatTypeSchema = z.enum(["dm", "group", "channel", "thread"]);
export type ChannelChatType = z.infer<typeof ChannelChatTypeSchema>;

export const ChannelAttachmentSchema = z.object({
  id: z.string().optional(),
  kind: z.enum(["image", "audio", "video", "file"]),
  name: z.string().optional(),
  mimeType: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
  url: z.string().optional(),
  /** 本地缓存路径或鉴权后的可读路径。 */
  path: z.string().optional(),
});
export type ChannelAttachment = z.infer<typeof ChannelAttachmentSchema>;

export const ChannelReplyContextSchema = z.object({
  messageId: z.string().optional(),
  userId: z.string().optional(),
  userName: z.string().optional(),
  text: z.string().optional(),
});
export type ChannelReplyContext = z.infer<typeof ChannelReplyContextSchema>;

/** 入站消息（已归一化，媒体已下载为 ContentPart）。 */
export const InboundMessageSchema = z.object({
  channel: ChannelKindSchema,
  /** 平台消息 id，用于去重、回复引用和审计。 */
  messageId: z.string().optional(),
  /** 平台稳定用户 id —— 会话映射键。 */
  channelUserId: z.string(),
  channelUserName: z.string().optional(),
  /** dm/group/channel id —— 回复目标。 */
  channelChatId: z.string(),
  channelChatName: z.string().optional(),
  channelChatType: ChannelChatTypeSchema.optional(),
  /** 话题 / thread / forum topic id。 */
  channelThreadId: z.string().optional(),
  replyTo: ChannelReplyContextSchema.optional(),
  attachments: z.array(ChannelAttachmentSchema).optional(),
  parts: z.array(ContentPartSchema),
  raw: z.unknown().optional(),
});
export type InboundMessage = z.infer<typeof InboundMessageSchema>;

/** 出站分块。多数 IM 无法逐 token 流式 → 按句界/防抖批量发送。 */
export interface OutboundChunk {
  text?: string;
  final?: boolean;
  attachments?: z.infer<typeof ContentPartSchema>[];
}

export const ChannelTargetSchema = z.object({
  channelChatId: z.string(),
  channelThreadId: z.string().optional(),
  replyToMessageId: z.string().optional(),
});
export type ChannelTarget = z.infer<typeof ChannelTargetSchema>;

export const ChannelOutboundSchema = z.object({
  text: z.string().optional(),
  parts: z.array(ContentPartSchema).optional(),
  attachments: z.array(ContentPartSchema).optional(),
  final: z.boolean().optional(),
});
export type ChannelOutbound = z.infer<typeof ChannelOutboundSchema>;

export const ChannelAuthConfigSchema = z.object({
  allowAll: z.boolean().optional(),
  allowedUsers: z.array(z.string()).optional(),
  allowedChats: z.array(z.string()).optional(),
});
export type ChannelAuthConfig = z.infer<typeof ChannelAuthConfigSchema>;

export const ChannelConfigSchema = z.object({
  id: z.string(),
  kind: ChannelKindSchema.exclude(["inapp"]),
  enabled: z.boolean().default(false),
  displayName: z.string().optional(),
  /** 临时持久化：后续迁 keychain 时可替换为 SecretRef。 */
  secrets: z.record(z.string(), z.string()).default({}),
  options: z.record(z.string(), z.unknown()).default({}),
  auth: ChannelAuthConfigSchema.default({}),
});
export type ChannelConfig = z.infer<typeof ChannelConfigSchema>;

export const ChannelAdapterMetaSchema = z.object({
  kind: ChannelConfigSchema.shape.kind,
  label: z.string(),
  description: z.string().optional(),
  requiredSecrets: z.array(z.object({ key: z.string(), label: z.string(), password: z.boolean().optional() })),
  optionalSecrets: z.array(z.object({ key: z.string(), label: z.string(), password: z.boolean().optional() })).optional(),
  supportsWebhook: z.boolean().optional(),
  supportsStreamingEdit: z.boolean().optional(),
  supportsButtons: z.boolean().optional(),
  supportsAttachments: z.boolean().optional(),
  maxMessageLength: z.number().int().positive().optional(),
});
export type ChannelAdapterMeta = z.infer<typeof ChannelAdapterMetaSchema>;

export const ChannelStatusSchema = z.object({
  id: z.string(),
  kind: ChannelConfigSchema.shape.kind,
  enabled: z.boolean(),
  running: z.boolean(),
  displayName: z.string().optional(),
  lastError: z.string().optional(),
  lastInboundAt: z.string().optional(),
  lastOutboundAt: z.string().optional(),
});
export type ChannelStatus = z.infer<typeof ChannelStatusSchema>;

/** 渠道身份 → 会话引用。 */
export interface SessionRef {
  threadId: string;
}

/**
 * 旧 IM 连接器兼容接口。新平台优先实现 @ew/im-connectors 的 ChannelAdapter。
 * 个人微信走腾讯 iLink Bot API 的扫码登录长轮询；WeCom 仍用于企业微信。
 */
export interface ChannelConnector {
  readonly kind: ChannelKind;
  start(): Promise<void>;
  stop(): Promise<void>;
  onInbound(handler: (msg: InboundMessage) => Promise<void>): void;
  reply(
    target: { channelChatId: string },
    stream: AsyncIterable<OutboundChunk>,
  ): Promise<void>;
}
