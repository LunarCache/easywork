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

/** 入站消息（已归一化，媒体已下载为 ContentPart）。 */
export const InboundMessageSchema = z.object({
  channel: ChannelKindSchema,
  /** 平台稳定用户 id —— 会话映射键。 */
  channelUserId: z.string(),
  /** dm/group/channel id —— 回复目标。 */
  channelChatId: z.string(),
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

/** 渠道身份 → 会话引用。 */
export interface SessionRef {
  threadId: string;
}

/**
 * IM 连接器接口。各平台（Telegram/Discord/WeCom/Feishu）实现它。
 * 个人微信无官方机器人 API → wechat 仅为实验性占位，默认关闭。
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
