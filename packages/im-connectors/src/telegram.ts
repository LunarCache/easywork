import type {
  ChannelAdapterMeta,
  ChannelConnector,
  ChannelOutbound,
  ChannelTarget,
  InboundMessage,
  OutboundChunk,
} from "@ew/shared";
import type { ChannelAdapter, ChannelAdapterContext, SendResult } from "./adapter.js";

export interface TelegramOptions {
  token: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** 长轮询超时秒数（默认 25）。 */
  pollTimeout?: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Telegram 连接器（Bot API，纯 HTTP，无 SDK 依赖，注入 fetch 可测）。
 * 多数 IM 无法逐 token 流式 → reply 累积文本后单条发送（流式编辑留作增强）。
 */
export class TelegramConnector implements ChannelConnector {
  readonly kind = "telegram" as const;
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly pollTimeout: number;
  private handler?: (msg: InboundMessage) => Promise<void>;
  private offset = 0;
  private running = false;
  private abort?: AbortController;

  constructor(opts: TelegramOptions) {
    this.token = opts.token;
    this.baseUrl = (opts.baseUrl ?? "https://api.telegram.org").replace(/\/$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
    this.pollTimeout = opts.pollTimeout ?? 25;
  }

  onInbound(handler: (msg: InboundMessage) => Promise<void>): void {
    this.handler = handler;
  }

  private async api(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
    const res = await this.fetchImpl(`${this.baseUrl}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
      signal,
    });
    return res.json();
  }

  /** 拉取一轮更新并分发（测试可直接调用）。 */
  async pollOnce(signal?: AbortSignal): Promise<number> {
    const data = await this.api("getUpdates", { offset: this.offset, timeout: this.pollTimeout }, signal);
    const updates: any[] = data?.result ?? [];
    for (const u of updates) {
      this.offset = Math.max(this.offset, (u.update_id ?? 0) + 1);
      const m = u.message ?? u.edited_message;
      if (!m?.text || !this.handler) continue;
      const inbound: InboundMessage = {
        channel: "telegram",
        channelUserId: String(m.from?.id ?? m.chat?.id ?? ""),
        channelChatId: String(m.chat?.id ?? ""),
        parts: [{ type: "text", text: String(m.text) }],
        raw: u,
      };
      if (m.message_id !== undefined) inbound.messageId = String(m.message_id);
      const userName = [m.from?.first_name, m.from?.last_name].filter(Boolean).join(" ") || m.from?.username;
      if (userName) inbound.channelUserName = userName;
      const chatName = m.chat?.title ?? m.chat?.username;
      if (chatName) inbound.channelChatName = chatName;
      if (m.chat?.type) inbound.channelChatType = m.chat.type === "private" ? "dm" : m.chat.type === "channel" ? "channel" : "group";
      if (m.message_thread_id !== undefined) inbound.channelThreadId = String(m.message_thread_id);
      await this.handler(inbound);
    }
    return updates.length;
  }

  async start(): Promise<void> {
    this.running = true;
    while (this.running) {
      const ac = new AbortController();
      this.abort = ac;
      try {
        await this.pollOnce(ac.signal);
      } catch {
        if (!this.running) break;
        await new Promise((r) => setTimeout(r, 1000));
      } finally {
        if (this.abort === ac) this.abort = undefined;
      }
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abort?.abort();
  }

  async reply(target: ChannelTarget, stream: AsyncIterable<OutboundChunk>): Promise<void> {
    let text = "";
    for await (const chunk of stream) {
      if (chunk.text) text += chunk.text;
    }
    const out = text.trim() || "(无内容)";
    // Telegram 单条上限 4096 字符，超长分段发送。
    for (let i = 0; i < out.length; i += 4096) {
      const params: Record<string, unknown> = { chat_id: target.channelChatId, text: out.slice(i, i + 4096) };
      if (target.channelThreadId) {
        const threadId = Number(target.channelThreadId);
        params.message_thread_id = Number.isInteger(threadId) ? threadId : target.channelThreadId;
      }
      if (target.replyToMessageId) {
        const replyId = Number(target.replyToMessageId);
        params.reply_to_message_id = Number.isInteger(replyId) ? replyId : target.replyToMessageId;
      }
      await this.api("sendMessage", params);
    }
  }
}

export class TelegramChannelAdapter implements ChannelAdapter {
  readonly kind = "telegram" as const;
  readonly meta = telegramAdapterMeta;
  private connector?: TelegramConnector;
  private running = false;
  private pollTask?: Promise<void>;
  private abort?: AbortController;

  constructor(private readonly opts: TelegramOptions) {}

  async start(ctx: ChannelAdapterContext): Promise<void> {
    if (this.running) return;
    const connector = new TelegramConnector(this.opts);
    connector.onInbound((message) => ctx.emitInbound(message));
    this.connector = connector;
    this.running = true;
    this.pollTask = this.pollLoop(connector, ctx);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abort?.abort();
    await this.connector?.stop();
    await this.pollTask?.catch(() => {});
    this.connector = undefined;
    this.pollTask = undefined;
    this.abort = undefined;
  }

  async send(target: ChannelTarget, message: ChannelOutbound): Promise<SendResult> {
    if (!this.connector) return { ok: false, error: "telegram_not_started" };
    async function* chunks(): AsyncIterable<OutboundChunk> {
      yield { text: message.text ?? "", final: true };
    }
    try {
      await this.connector.reply(target, chunks());
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), retryable: true };
    }
  }

  private async pollLoop(connector: TelegramConnector, ctx: ChannelAdapterContext): Promise<void> {
    while (this.running) {
      const ac = new AbortController();
      this.abort = ac;
      try {
        await connector.pollOnce(ac.signal);
        if (this.running) ctx.setStatus({ running: true, lastError: undefined });
      } catch (err) {
        if (!this.running) break;
        ctx.setStatus({ lastError: err instanceof Error ? err.message : String(err) });
        await new Promise((r) => setTimeout(r, 1000));
      } finally {
        if (this.abort === ac) this.abort = undefined;
      }
    }
  }
}

export const telegramAdapterMeta: ChannelAdapterMeta = {
  kind: "telegram",
  label: "Telegram",
  description: "Telegram Bot API long-poll connector",
  requiredSecrets: [{ key: "token", label: "Bot token", password: true }],
  optionalSecrets: [],
  supportsWebhook: false,
  supportsStreamingEdit: false,
  supportsButtons: false,
  supportsAttachments: false,
  maxMessageLength: 4096,
};

export const telegramAdapterEntry = {
  meta: telegramAdapterMeta,
  create(config) {
    const token = config.secrets.token || config.options.token;
    if (!token || typeof token !== "string") throw new Error("Telegram token is required");
    return new TelegramChannelAdapter({
      token,
      baseUrl: typeof config.options.baseUrl === "string" ? config.options.baseUrl : undefined,
      pollTimeout: typeof config.options.pollTimeout === "number" ? config.options.pollTimeout : undefined,
    });
  },
} satisfies import("./adapter.js").ChannelAdapterEntry;
