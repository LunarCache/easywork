import type { ChannelConnector, InboundMessage, OutboundChunk } from "@ew/shared";

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

  constructor(opts: TelegramOptions) {
    this.token = opts.token;
    this.baseUrl = (opts.baseUrl ?? "https://api.telegram.org").replace(/\/$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
    this.pollTimeout = opts.pollTimeout ?? 25;
  }

  onInbound(handler: (msg: InboundMessage) => Promise<void>): void {
    this.handler = handler;
  }

  private async api(method: string, params: Record<string, unknown>): Promise<any> {
    const res = await this.fetchImpl(`${this.baseUrl}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    });
    return res.json();
  }

  /** 拉取一轮更新并分发（测试可直接调用）。 */
  async pollOnce(): Promise<number> {
    const data = await this.api("getUpdates", { offset: this.offset, timeout: this.pollTimeout });
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
      await this.handler(inbound);
    }
    return updates.length;
  }

  async start(): Promise<void> {
    this.running = true;
    while (this.running) {
      try {
        await this.pollOnce();
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  async reply(target: { channelChatId: string }, stream: AsyncIterable<OutboundChunk>): Promise<void> {
    let text = "";
    for await (const chunk of stream) {
      if (chunk.text) text += chunk.text;
    }
    const out = text.trim() || "(无内容)";
    // Telegram 单条上限 4096 字符，超长分段发送。
    for (let i = 0; i < out.length; i += 4096) {
      await this.api("sendMessage", { chat_id: target.channelChatId, text: out.slice(i, i + 4096) });
    }
  }
}
