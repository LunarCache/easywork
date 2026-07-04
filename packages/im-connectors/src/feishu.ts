import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";
import type {
  ChannelAdapterMeta,
  ChannelOutbound,
  ChannelTarget,
  InboundMessage,
} from "@ew/shared";
import type { ChannelAdapter, ChannelAdapterContext, SendResult, WebhookRequest, WebhookResult } from "./adapter.js";

export type FeishuReceiveIdType = "chat_id" | "open_id" | "user_id" | "union_id" | "email";
export type FeishuTransport = "websocket" | "webhook";
export type FeishuDomain = "feishu" | "lark";

export interface FeishuOptions {
  appId: string;
  appSecret: string;
  verificationToken?: string;
  encryptKey?: string;
  transport?: FeishuTransport;
  domain?: FeishuDomain;
  baseUrl?: string;
  receiveIdType?: FeishuReceiveIdType;
  fetch?: typeof fetch;
  handshakeTimeoutMs?: number;
  sdkChannelFactory?: FeishuSdkChannelFactory;
}

interface TenantTokenCache {
  token: string;
  expiresAtMs: number;
}

export interface FeishuSdkMessage {
  messageId: string;
  chatId: string;
  chatType: "p2p" | "group";
  senderId: string;
  senderName?: string;
  content: string;
  rawContentType?: string;
  rootId?: string;
  threadId?: string;
  replyToMessageId?: string;
  raw?: unknown;
}

export interface FeishuSdkChannel {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  on(name: "message", handler: (msg: FeishuSdkMessage) => void | Promise<void>): () => void;
  on(name: "error" | "reconnecting" | "reconnected" | "reject", handler: (event: unknown) => void | Promise<void>): () => void;
  send(to: string, input: { text: string }, opts?: { replyTo?: string }): Promise<{ messageId?: string }>;
  getConnectionStatus?(): { state?: string; reconnectAttempts?: number } | undefined;
}

export interface FeishuSdkChannelFactoryOptions {
  appId: string;
  appSecret: string;
  domain: FeishuDomain;
  handshakeTimeoutMs?: number;
}

export type FeishuSdkChannelFactory =
  (options: FeishuSdkChannelFactoryOptions) => FeishuSdkChannel | Promise<FeishuSdkChannel>;

export interface FeishuRegistrationOptions {
  region?: FeishuDomain;
  signal?: AbortSignal;
  onQRCodeReady(info: { url: string; expireIn: number }): void;
  onStatusChange?(info: { status: string; interval?: number }): void;
}

export interface FeishuRegistrationResult {
  appId: string;
  appSecret: string;
  tenantBrand?: FeishuDomain;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function numberValue(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" ? value : undefined;
}

function recordValue(record: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const value = record?.[key];
  return isRecord(value) ? value : undefined;
}

function getHeader(headers: WebhookRequest["headers"], name: string): string | undefined {
  const needle = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== needle) continue;
    if (Array.isArray(value)) return value[0];
    return value;
  }
  return undefined;
}

function rawBody(request: WebhookRequest): string | Buffer {
  if (request.rawBody !== undefined) return request.rawBody;
  return JSON.stringify(request.body ?? {});
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function parseJsonBody(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function parseTextContent(content: unknown): string | undefined {
  if (typeof content !== "string") return undefined;
  try {
    const parsed = JSON.parse(content) as unknown;
    if (isRecord(parsed)) return stringValue(parsed, "text");
  } catch {
    return content;
  }
  return undefined;
}

function outboundText(message: ChannelOutbound): string {
  if (message.text !== undefined) return message.text;
  return (message.parts ?? [])
    .filter((part): part is Extract<NonNullable<ChannelOutbound["parts"]>[number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text };
  }
}

export function calculateFeishuSignature(
  timestamp: string,
  nonce: string,
  encryptKey: string,
  body: string | Buffer,
): string {
  const hash = createHash("sha256");
  hash.update(timestamp + nonce + encryptKey, "utf8");
  hash.update(body);
  return hash.digest("hex");
}

export function decryptFeishuEvent(encrypted: string, encryptKey: string): Record<string, unknown> {
  const payload = Buffer.from(encrypted, "base64");
  if (payload.length <= 16) throw new Error("feishu_encrypted_payload_too_short");
  const key = createHash("sha256").update(encryptKey, "utf8").digest();
  const iv = payload.subarray(0, 16);
  const ciphertext = payload.subarray(16);
  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const padding = decrypted[decrypted.length - 1] ?? 0;
  const unpadded = padding > 0 && padding <= 16 ? decrypted.subarray(0, decrypted.length - padding) : decrypted;
  const parsed = JSON.parse(unpadded.toString("utf8")) as unknown;
  if (!isRecord(parsed)) throw new Error("feishu_decrypted_payload_invalid");
  return parsed;
}

function domainBaseUrl(domain: FeishuDomain): string {
  return domain === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
}

function normalizeDomain(value: unknown): FeishuDomain | undefined {
  return value === "lark" || value === "feishu" ? value : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isTextLikeMessageType(value: string | undefined): boolean {
  return !value || value === "text" || value === "post";
}

async function createDefaultFeishuSdkChannel(options: FeishuSdkChannelFactoryOptions): Promise<FeishuSdkChannel> {
  const lark = await import("@larksuiteoapi/node-sdk");
  return lark.createLarkChannel({
    appId: options.appId,
    appSecret: options.appSecret,
    domain: options.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu,
    transport: "websocket",
    source: "easywork",
    includeRawEvent: true,
    handshakeTimeoutMs: options.handshakeTimeoutMs ?? 15_000,
    loggerLevel: lark.LoggerLevel.warn,
    policy: {
      dmMode: "open",
      requireMention: false,
      respondToMentionAll: true,
    },
  }) as FeishuSdkChannel;
}

export async function registerFeishuApp(options: FeishuRegistrationOptions): Promise<FeishuRegistrationResult> {
  const lark = await import("@larksuiteoapi/node-sdk");
  const result = await lark.registerApp({
    source: "easywork",
    ...(options.region === "lark" ? { domain: "accounts.larksuite.com", larkDomain: "accounts.larksuite.com" } : {}),
    signal: options.signal,
    appPreset: {
      name: "EasyWork {user}",
      desc: "EasyWork local AI workspace bot",
    },
    addons: {
      scopes: { tenant: ["im:message:send_as_bot"] },
      events: { items: { tenant: ["im.message.receive_v1"] } },
    },
    createOnly: true,
    onQRCodeReady: options.onQRCodeReady,
    onStatusChange: options.onStatusChange,
  });
  return {
    appId: result.client_id,
    appSecret: result.client_secret,
    tenantBrand: normalizeDomain(result.user_info?.tenant_brand),
  };
}

export class FeishuChannelAdapter implements ChannelAdapter {
  readonly kind = "feishu" as const;
  readonly meta = feishuAdapterMeta;
  private ctx?: ChannelAdapterContext;
  private tokenCache?: TenantTokenCache;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly receiveIdType: FeishuReceiveIdType;
  private readonly transport: FeishuTransport;
  private readonly domain: FeishuDomain;
  private sdkChannel?: FeishuSdkChannel;
  private unsubscribers: Array<() => void> = [];

  constructor(private readonly opts: FeishuOptions) {
    this.domain = opts.domain ?? "feishu";
    this.transport = opts.transport ?? "websocket";
    this.baseUrl = (opts.baseUrl ?? domainBaseUrl(this.domain)).replace(/\/$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
    this.receiveIdType = opts.receiveIdType ?? "chat_id";
  }

  async start(ctx: ChannelAdapterContext): Promise<void> {
    this.ctx = ctx;
    if (this.transport === "webhook") return;
    const channel = await (this.opts.sdkChannelFactory ?? createDefaultFeishuSdkChannel)({
      appId: this.opts.appId,
      appSecret: this.opts.appSecret,
      domain: this.domain,
      handshakeTimeoutMs: this.opts.handshakeTimeoutMs,
    });
    this.sdkChannel = channel;
    this.unsubscribers = [
      channel.on("message", (message) => this.handleSdkMessage(message)),
      channel.on("error", (err) => ctx.setStatus({ lastError: errorMessage(err) })),
      channel.on("reject", (event) => ctx.setStatus({ lastError: `feishu_message_rejected:${errorMessage(event)}` })),
      channel.on("reconnecting", () => ctx.setStatus({ lastError: "feishu_reconnecting" })),
      channel.on("reconnected", () => ctx.setStatus({ lastError: undefined })),
    ];
    await channel.connect();
    ctx.setStatus({ running: true, lastError: undefined });
  }

  async stop(): Promise<void> {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    await this.sdkChannel?.disconnect().catch(() => {});
    this.sdkChannel = undefined;
    this.ctx = undefined;
  }

  async handleWebhook(request: WebhookRequest): Promise<WebhookResult> {
    if (this.transport !== "webhook") {
      return { status: 404, body: { error: "feishu_webhook_not_enabled" } };
    }
    if (!this.opts.verificationToken && !this.opts.encryptKey) {
      return { status: 401, body: { error: "feishu_webhook_secret_required" } };
    }

    const verified = this.verifySignature(request);
    if (!verified.ok) return verified.result;

    const parsedBody = parseJsonBody(request.body);
    if (!parsedBody) return { status: 400, body: { error: "invalid_feishu_payload" } };

    const body = this.decryptIfNeeded(parsedBody);
    if (!body.ok) return body.result;

    const tokenOk = this.verifyToken(body.payload);
    if (!tokenOk) return { status: 401, body: { error: "feishu_verification_token_invalid" } };

    if (stringValue(body.payload, "type") === "url_verification") {
      const challenge = stringValue(body.payload, "challenge");
      if (!challenge) return { status: 400, body: { error: "feishu_challenge_missing" } };
      return { body: { challenge } };
    }

    const eventType = stringValue(recordValue(body.payload, "header"), "event_type") ?? stringValue(body.payload, "type");
    if (eventType !== "im.message.receive_v1") return { body: { ok: true, ignored: true } };

    const inbound = this.parseMessageEvent(body.payload);
    if (!inbound) return { body: { ok: true, ignored: true } };
    if (!this.ctx) return { status: 409, body: { error: "feishu_adapter_not_started" } };

    await this.ctx.emitInbound(inbound);
    return { body: { ok: true } };
  }

  async send(target: ChannelTarget, message: ChannelOutbound): Promise<SendResult> {
    const text = outboundText(message).trim() || "(无内容)";
    if (!target.channelChatId) return { ok: false, error: "feishu_target_missing" };

    try {
      if (this.sdkChannel) {
        const result = await this.sdkChannel.send(
          target.channelChatId,
          { text },
          target.replyToMessageId ? { replyTo: target.replyToMessageId } : undefined,
        );
        return { ok: true, messageId: result.messageId };
      }
      const token = await this.getTenantAccessToken();
      const url = `${this.baseUrl}/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(this.receiveIdType)}`;
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          receive_id: target.channelChatId,
          msg_type: "text",
          content: JSON.stringify({ text }),
        }),
      });
      const data = await readJson(res);
      const record = isRecord(data) ? data : {};
      if (!res.ok || numberValue(record, "code") !== 0) {
        return {
          ok: false,
          error: stringValue(record, "msg") ?? stringValue(record, "message") ?? `feishu_send_failed_${res.status}`,
          retryable: res.status === 429 || res.status >= 500,
        };
      }
      const dataRecord = recordValue(record, "data");
      return { ok: true, messageId: stringValue(dataRecord, "message_id") };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), retryable: true };
    }
  }

  private async handleSdkMessage(message: FeishuSdkMessage): Promise<void> {
    if (!this.ctx) return;
    if (!isTextLikeMessageType(message.rawContentType)) return;
    const text = message.content?.trim();
    if (!text) return;
    await this.ctx.emitInbound({
      channel: "feishu",
      messageId: message.messageId,
      channelUserId: message.senderId,
      ...(message.senderName ? { channelUserName: message.senderName } : {}),
      channelChatId: message.chatId,
      channelChatType: message.chatType === "p2p" ? "dm" : "group",
      ...(message.threadId ?? message.rootId ? { channelThreadId: message.threadId ?? message.rootId } : {}),
      ...(message.replyToMessageId ? { replyTo: { messageId: message.replyToMessageId } } : {}),
      parts: [{ type: "text", text }],
      raw: message.raw ?? message,
    });
  }

  private verifySignature(request: WebhookRequest): { ok: true } | { ok: false; result: WebhookResult } {
    const encryptKey = this.opts.encryptKey;
    if (!encryptKey) return { ok: true };
    const timestamp = getHeader(request.headers, "x-lark-request-timestamp");
    const nonce = getHeader(request.headers, "x-lark-request-nonce");
    const signature = getHeader(request.headers, "x-lark-signature");
    if (!timestamp || !nonce || !signature) {
      return { ok: false, result: { status: 401, body: { error: "feishu_signature_missing" } } };
    }
    const expected = calculateFeishuSignature(timestamp, nonce, encryptKey, rawBody(request));
    if (!timingSafeStringEqual(signature, expected)) {
      return { ok: false, result: { status: 401, body: { error: "feishu_signature_invalid" } } };
    }
    return { ok: true };
  }

  private decryptIfNeeded(body: Record<string, unknown>): { ok: true; payload: Record<string, unknown> } | { ok: false; result: WebhookResult } {
    const encrypted = stringValue(body, "encrypt");
    if (!encrypted) return { ok: true, payload: body };
    const encryptKey = this.opts.encryptKey;
    if (!encryptKey) return { ok: false, result: { status: 401, body: { error: "feishu_encrypt_key_required" } } };
    try {
      return { ok: true, payload: decryptFeishuEvent(encrypted, encryptKey) };
    } catch (err) {
      return {
        ok: false,
        result: {
          status: 400,
          body: { error: "feishu_decrypt_failed", message: err instanceof Error ? err.message : String(err) },
        },
      };
    }
  }

  private verifyToken(body: Record<string, unknown>): boolean {
    const expected = this.opts.verificationToken;
    if (!expected) return true;
    const actual =
      stringValue(body, "token") ??
      stringValue(recordValue(body, "header"), "token") ??
      stringValue(recordValue(body, "event"), "token");
    return actual === expected;
  }

  private parseMessageEvent(body: Record<string, unknown>): InboundMessage | undefined {
    const event = recordValue(body, "event");
    const message = recordValue(event, "message");
    if (!event || !message) return undefined;

    const sender = recordValue(event, "sender");
    if (stringValue(sender, "sender_type") === "app") return undefined;
    const senderId = recordValue(sender, "sender_id");
    const channelUserId =
      stringValue(senderId, "open_id") ??
      stringValue(senderId, "union_id") ??
      stringValue(senderId, "user_id");
    const channelChatId = stringValue(message, "chat_id");
    if (!channelUserId || !channelChatId) return undefined;

    const messageType = stringValue(message, "message_type");
    if (messageType !== "text") return undefined;
    const text = parseTextContent(message.content);
    if (!text?.trim()) return undefined;

    const inbound: InboundMessage = {
      channel: "feishu",
      channelUserId,
      channelChatId,
      parts: [{ type: "text", text }],
      raw: body,
    };
    const messageId = stringValue(message, "message_id");
    if (messageId) inbound.messageId = messageId;
    const chatType = stringValue(message, "chat_type");
    if (chatType) inbound.channelChatType = chatType === "p2p" ? "dm" : chatType === "group" ? "group" : "channel";
    const threadId = stringValue(message, "thread_id");
    if (threadId) inbound.channelThreadId = threadId;
    const senderName = stringValue(sender, "sender_name") ?? stringValue(sender, "sender_name_en");
    if (senderName) inbound.channelUserName = senderName;
    return inbound;
  }

  private async getTenantAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.tokenCache && this.tokenCache.expiresAtMs > now) return this.tokenCache.token;

    const res = await this.fetchImpl(`${this.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ app_id: this.opts.appId, app_secret: this.opts.appSecret }),
    });
    const data = await readJson(res);
    const record = isRecord(data) ? data : {};
    const token = stringValue(record, "tenant_access_token");
    if (!res.ok || numberValue(record, "code") !== 0 || !token) {
      throw new Error(stringValue(record, "msg") ?? stringValue(record, "message") ?? `feishu_token_failed_${res.status}`);
    }
    const expireSeconds = numberValue(record, "expire") ?? 7200;
    this.tokenCache = {
      token,
      expiresAtMs: now + Math.max(60, expireSeconds - 60) * 1000,
    };
    return token;
  }
}

export const feishuAdapterMeta: ChannelAdapterMeta = {
  kind: "feishu",
  label: "Feishu / Lark",
  description: "Feishu/Lark connector; WebSocket long connection by default, webhook as advanced mode",
  requiredSecrets: [
    { key: "appId", label: "App ID" },
    { key: "appSecret", label: "App Secret", password: true },
  ],
  optionalSecrets: [
    { key: "verificationToken", label: "Verification Token", password: true },
    { key: "encryptKey", label: "Encrypt Key", password: true },
  ],
  supportsWebhook: true,
  supportsStreamingEdit: false,
  supportsButtons: false,
  supportsAttachments: false,
  maxMessageLength: 15000,
};

export const feishuAdapterEntry = {
  meta: feishuAdapterMeta,
  create(config) {
    const appId = config.secrets.appId || config.options.appId;
    const appSecret = config.secrets.appSecret || config.options.appSecret;
    if (!appId || typeof appId !== "string") throw new Error("Feishu App ID is required");
    if (!appSecret || typeof appSecret !== "string") throw new Error("Feishu App Secret is required");
    const receiveIdType = config.options.receiveIdType;
    return new FeishuChannelAdapter({
      appId,
      appSecret,
      verificationToken: typeof config.secrets.verificationToken === "string" ? config.secrets.verificationToken : undefined,
      encryptKey: typeof config.secrets.encryptKey === "string" ? config.secrets.encryptKey : undefined,
      transport: isFeishuTransport(config.options.transport) ? config.options.transport : undefined,
      domain: normalizeDomain(config.options.domain),
      baseUrl: typeof config.options.baseUrl === "string" ? config.options.baseUrl : undefined,
      receiveIdType: isFeishuReceiveIdType(receiveIdType) ? receiveIdType : undefined,
      handshakeTimeoutMs: typeof config.options.handshakeTimeoutMs === "number" ? config.options.handshakeTimeoutMs : undefined,
    });
  },
} satisfies import("./adapter.js").ChannelAdapterEntry;

function isFeishuTransport(value: unknown): value is FeishuTransport {
  return value === "websocket" || value === "webhook";
}

function isFeishuReceiveIdType(value: unknown): value is FeishuReceiveIdType {
  return value === "chat_id" || value === "open_id" || value === "user_id" || value === "union_id" || value === "email";
}
