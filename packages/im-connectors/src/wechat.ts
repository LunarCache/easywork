import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ChannelAdapterMeta,
  ChannelOutbound,
  ChannelTarget,
  InboundMessage,
} from "@ew/shared";
import type { ChannelAdapter, ChannelAdapterContext, SendResult } from "./adapter.js";

const ILINK_BASE_URL = "https://ilinkai.weixin.qq.com";
const ILINK_APP_ID = "bot";
const CHANNEL_VERSION = "2.2.0";
const ILINK_APP_CLIENT_VERSION = String((2 << 16) | (2 << 8) | 0);

const EP_GET_UPDATES = "ilink/bot/getupdates";
const EP_SEND_MESSAGE = "ilink/bot/sendmessage";
const EP_GET_BOT_QR = "ilink/bot/get_bot_qrcode";
const EP_GET_QR_STATUS = "ilink/bot/get_qrcode_status";

const LONG_POLL_TIMEOUT_MS = 35_000;
const API_TIMEOUT_MS = 15_000;
const QR_TIMEOUT_MS = 35_000;
const SESSION_EXPIRED_ERRCODE = -14;
const RATE_LIMIT_ERRCODE = -2;
const MESSAGE_DEDUP_TTL_MS = 5 * 60 * 1000;

const ITEM_TEXT = 1;
const ITEM_VOICE = 3;
const MSG_TYPE_USER = 1;
const MSG_TYPE_BOT = 2;
const MSG_STATE_FINISH = 2;

export type WechatGroupPolicy = "disabled" | "open" | "allowlist";

export interface WechatOptions {
  accountId: string;
  token: string;
  baseUrl?: string;
  stateDir?: string;
  groupPolicy?: WechatGroupPolicy;
  groupAllowlist?: string[];
  pollTimeoutMs?: number;
  maxMessageLength?: number;
  fetch?: typeof fetch;
}

export interface WechatRegistrationOptions {
  signal?: AbortSignal;
  botType?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  onQRCodeReady(info: { url: string; expireIn: number; rawCode: string }): void;
  onStatusChange?(info: { status: string }): void;
}

export interface WechatRegistrationResult {
  accountId: string;
  token: string;
  baseUrl: string;
  userId?: string;
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

function jsonStringify(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

function randomWechatUin(): string {
  const raw = String(randomBytes(4).readUInt32BE(0));
  return Buffer.from(raw, "utf8").toString("base64");
}

function headers(token: string | undefined, body: string): Record<string, string> {
  const out: Record<string, string> = {
    "content-type": "application/json",
    "authorizationtype": "ilink_bot_token",
    "content-length": String(Buffer.byteLength(body)),
    "x-wechat-uin": randomWechatUin(),
    "ilink-app-id": ILINK_APP_ID,
    "ilink-app-clientversion": ILINK_APP_CLIENT_VERSION,
  };
  if (token) out.authorization = `Bearer ${token}`;
  return out;
}

function defaultStateDir(): string {
  return path.join(process.env.EW_DATA_DIR || path.join(os.homedir(), ".easywork"), "im", "wechat");
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function safeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.@-]/g, "_") || "account";
}

function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function atomicWriteJson(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function stateFile(stateDir: string, accountId: string, suffix: string): string {
  return path.join(stateDir, `${safeFilePart(accountId)}.${suffix}.json`);
}

class WechatStateStore {
  private readonly contextTokens = new Map<string, string>();

  constructor(private readonly root: string) {
    ensureDir(root);
  }

  restoreContextTokens(accountId: string): void {
    const data = readJsonFile(stateFile(this.root, accountId, "context-tokens"));
    if (!isRecord(data)) return;
    this.contextTokens.clear();
    for (const [peer, token] of Object.entries(data)) {
      if (typeof token === "string" && token) this.contextTokens.set(peer, token);
    }
  }

  getContextToken(peerId: string): string | undefined {
    return this.contextTokens.get(peerId);
  }

  setContextToken(accountId: string, peerId: string, token: string): void {
    this.contextTokens.set(peerId, token);
    atomicWriteJson(stateFile(this.root, accountId, "context-tokens"), Object.fromEntries(this.contextTokens));
  }

  deleteContextToken(accountId: string, peerId: string): void {
    this.contextTokens.delete(peerId);
    atomicWriteJson(stateFile(this.root, accountId, "context-tokens"), Object.fromEntries(this.contextTokens));
  }

  loadSyncBuffer(accountId: string): string {
    const data = readJsonFile(stateFile(this.root, accountId, "sync"));
    return isRecord(data) && typeof data.get_updates_buf === "string" ? data.get_updates_buf : "";
  }

  saveSyncBuffer(accountId: string, syncBuffer: string): void {
    atomicWriteJson(stateFile(this.root, accountId, "sync"), { get_updates_buf: syncBuffer });
  }
}

function requestSignal(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const onAbort = () => ac.abort();
  if (parent?.aborted) ac.abort();
  else parent?.addEventListener("abort", onAbort, { once: true });
  const cleanup = () => {
    clearTimeout(timer);
    parent?.removeEventListener("abort", onAbort);
  };
  ac.signal.addEventListener("abort", cleanup, { once: true });
  return { signal: ac.signal, cleanup };
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("aborted");
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
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

async function apiGet(
  fetchImpl: typeof fetch,
  opts: { baseUrl: string; endpoint: string; timeoutMs: number; signal?: AbortSignal },
): Promise<Record<string, unknown>> {
  const timeout = requestSignal(opts.signal, opts.timeoutMs);
  try {
    const res = await fetchImpl(`${opts.baseUrl.replace(/\/$/, "")}/${opts.endpoint}`, {
      headers: {
        "ilink-app-id": ILINK_APP_ID,
        "ilink-app-clientversion": ILINK_APP_CLIENT_VERSION,
      },
      signal: timeout.signal,
    });
    const json = await readJson(res);
    if (!res.ok) throw new Error(`iLink GET ${opts.endpoint} failed: ${res.status}`);
    if (!isRecord(json)) throw new Error(`iLink GET ${opts.endpoint} returned invalid JSON`);
    return json;
  } finally {
    timeout.cleanup();
  }
}

async function apiPost(
  fetchImpl: typeof fetch,
  opts: {
    baseUrl: string;
    endpoint: string;
    payload: Record<string, unknown>;
    token?: string;
    timeoutMs: number;
    signal?: AbortSignal;
  },
): Promise<Record<string, unknown>> {
  const body = jsonStringify({ ...opts.payload, base_info: { channel_version: CHANNEL_VERSION } });
  const timeout = requestSignal(opts.signal, opts.timeoutMs);
  try {
    const res = await fetchImpl(`${opts.baseUrl.replace(/\/$/, "")}/${opts.endpoint}`, {
      method: "POST",
      headers: headers(opts.token, body),
      body,
      signal: timeout.signal,
    });
    const json = await readJson(res);
    if (!res.ok) throw new Error(`iLink POST ${opts.endpoint} failed: ${res.status}`);
    if (!isRecord(json)) throw new Error(`iLink POST ${opts.endpoint} returned invalid JSON`);
    return json;
  } finally {
    timeout.cleanup();
  }
}

function isStaleSession(ret: unknown, errcode: unknown, errmsg: unknown): boolean {
  if (ret !== RATE_LIMIT_ERRCODE && errcode !== RATE_LIMIT_ERRCODE) return false;
  return typeof errmsg === "string" && errmsg.toLowerCase() === "unknown error";
}

function outboundText(message: ChannelOutbound): string {
  if (message.text !== undefined) return message.text;
  return (message.parts ?? [])
    .filter((part): part is Extract<NonNullable<ChannelOutbound["parts"]>[number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function extractText(itemList: unknown): string {
  if (!Array.isArray(itemList)) return "";
  for (const item of itemList) {
    if (!isRecord(item)) continue;
    if (item.type === ITEM_TEXT) {
      const text = stringValue(isRecord(item.text_item) ? item.text_item : undefined, "text");
      if (text) return text;
    }
  }
  for (const item of itemList) {
    if (!isRecord(item)) continue;
    if (item.type === ITEM_VOICE) {
      const text = stringValue(isRecord(item.voice_item) ? item.voice_item : undefined, "text");
      if (text) return text;
    }
  }
  return "";
}

function guessChat(message: Record<string, unknown>, accountId: string): { chatType: "dm" | "group"; chatId: string } {
  const roomId = stringValue(message, "room_id") || stringValue(message, "chat_room_id") || "";
  const toUserId = stringValue(message, "to_user_id") || "";
  const senderId = stringValue(message, "from_user_id") || "";
  const isGroup = Boolean(roomId) || Boolean(toUserId && accountId && toUserId !== accountId && message.msg_type === MSG_TYPE_USER);
  return {
    chatType: isGroup ? "group" : "dm",
    chatId: isGroup ? (roomId || toUserId || senderId) : senderId,
  };
}

function splitText(text: string, maxLength: number): string[] {
  const normalized = text.trim();
  if (!normalized) return [];
  if (normalized.length <= maxLength) return [normalized];
  const chunks: string[] = [];
  let remaining = normalized;
  while (remaining.length > maxLength) {
    let cut = remaining.lastIndexOf("\n\n", maxLength);
    if (cut < maxLength * 0.5) cut = remaining.lastIndexOf("\n", maxLength);
    if (cut < maxLength * 0.5) cut = maxLength;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks.filter(Boolean);
}

async function sendIlinkText(
  fetchImpl: typeof fetch,
  opts: {
    baseUrl: string;
    token: string;
    to: string;
    text: string;
    contextToken?: string;
    clientId: string;
    signal?: AbortSignal;
  },
): Promise<Record<string, unknown>> {
  const msg: Record<string, unknown> = {
    from_user_id: "",
    to_user_id: opts.to,
    client_id: opts.clientId,
    message_type: MSG_TYPE_BOT,
    message_state: MSG_STATE_FINISH,
    item_list: [{ type: ITEM_TEXT, text_item: { text: opts.text } }],
  };
  if (opts.contextToken) msg.context_token = opts.contextToken;
  return apiPost(fetchImpl, {
    baseUrl: opts.baseUrl,
    endpoint: EP_SEND_MESSAGE,
    payload: { msg },
    token: opts.token,
    timeoutMs: API_TIMEOUT_MS,
    signal: opts.signal,
  });
}

export async function registerWechatAccount(options: WechatRegistrationOptions): Promise<WechatRegistrationResult> {
  const fetchImpl = options.fetch ?? fetch;
  let currentBaseUrl = ILINK_BASE_URL;
  let refreshCount = 0;
  let qr = await apiGet(fetchImpl, {
    baseUrl: ILINK_BASE_URL,
    endpoint: `${EP_GET_BOT_QR}?bot_type=${encodeURIComponent(options.botType ?? "3")}`,
    timeoutMs: QR_TIMEOUT_MS,
    signal: options.signal,
  });
  let rawCode = stringValue(qr, "qrcode") || "";
  let qrUrl = stringValue(qr, "qrcode_img_content") || rawCode;
  if (!rawCode) throw new Error("wechat_qr_missing_code");
  options.onQRCodeReady({ url: qrUrl, expireIn: 300, rawCode });
  const deadline = Date.now() + (options.timeoutMs ?? 8 * 60_000);

  while (Date.now() < deadline) {
    if (options.signal?.aborted) throw new Error("wechat_registration_aborted");
    const status = await apiGet(fetchImpl, {
      baseUrl: currentBaseUrl,
      endpoint: `${EP_GET_QR_STATUS}?qrcode=${encodeURIComponent(rawCode)}`,
      timeoutMs: QR_TIMEOUT_MS,
      signal: options.signal,
    }).catch(async (err) => {
      options.onStatusChange?.({ status: `poll_error:${err instanceof Error ? err.message : String(err)}` });
      await sleep(1_000, options.signal);
      return undefined;
    });
    if (!status) continue;
    const state = stringValue(status, "status") || "wait";
    options.onStatusChange?.({ status: state });
    if (state === "scaned_but_redirect") {
      const host = stringValue(status, "redirect_host");
      if (host) currentBaseUrl = `https://${host}`;
    } else if (state === "expired") {
      refreshCount += 1;
      if (refreshCount > 3) throw new Error("wechat_qr_expired");
      qr = await apiGet(fetchImpl, {
        baseUrl: ILINK_BASE_URL,
        endpoint: `${EP_GET_BOT_QR}?bot_type=${encodeURIComponent(options.botType ?? "3")}`,
        timeoutMs: QR_TIMEOUT_MS,
        signal: options.signal,
      });
      rawCode = stringValue(qr, "qrcode") || "";
      qrUrl = stringValue(qr, "qrcode_img_content") || rawCode;
      if (!rawCode) throw new Error("wechat_qr_missing_code");
      options.onQRCodeReady({ url: qrUrl, expireIn: 300, rawCode });
    } else if (state === "confirmed") {
      const accountId = stringValue(status, "ilink_bot_id") || "";
      const token = stringValue(status, "bot_token") || "";
      const baseUrl = stringValue(status, "baseurl") || currentBaseUrl || ILINK_BASE_URL;
      const userId = stringValue(status, "ilink_user_id");
      if (!accountId || !token) throw new Error("wechat_qr_missing_credentials");
      return {
        accountId,
        token,
        baseUrl,
        ...(userId ? { userId } : {}),
      };
    }
    await sleep(1_000, options.signal);
  }

  throw new Error("wechat_registration_timeout");
}

export class WechatChannelAdapter implements ChannelAdapter {
  readonly kind = "wechat" as const;
  readonly meta = wechatAdapterMeta;
  private ctx?: ChannelAdapterContext;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly state: WechatStateStore;
  private readonly groupPolicy: WechatGroupPolicy;
  private readonly groupAllowlist: string[];
  private readonly maxMessageLength: number;
  private abort?: AbortController;
  private pollTask?: Promise<void>;
  private sendChain = Promise.resolve();
  private readonly seen = new Map<string, number>();

  constructor(private readonly opts: WechatOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.baseUrl = (opts.baseUrl || ILINK_BASE_URL).replace(/\/$/, "");
    this.state = new WechatStateStore(opts.stateDir || defaultStateDir());
    this.groupPolicy = opts.groupPolicy ?? "disabled";
    this.groupAllowlist = opts.groupAllowlist ?? [];
    this.maxMessageLength = opts.maxMessageLength ?? 2_000;
  }

  async start(ctx: ChannelAdapterContext): Promise<void> {
    if (!this.opts.accountId) throw new Error("Wechat accountId is required");
    if (!this.opts.token) throw new Error("Wechat token is required");
    this.ctx = ctx;
    this.state.restoreContextTokens(this.opts.accountId);
    this.abort = new AbortController();
    this.pollTask = this.pollLoop(this.abort.signal);
    ctx.setStatus({ lastError: undefined });
  }

  async stop(): Promise<void> {
    this.abort?.abort();
    await this.pollTask?.catch(() => {});
    this.abort = undefined;
    this.pollTask = undefined;
  }

  async send(target: ChannelTarget, message: ChannelOutbound): Promise<SendResult> {
    const text = outboundText(message).trim();
    if (!text) return { ok: true };
    const run = this.sendChain.then(() => this.sendText(target.channelChatId, text));
    this.sendChain = run.then(() => undefined, () => undefined);
    return run;
  }

  private async pollLoop(signal: AbortSignal): Promise<void> {
    let syncBuffer = this.state.loadSyncBuffer(this.opts.accountId);
    let timeoutMs = this.opts.pollTimeoutMs ?? LONG_POLL_TIMEOUT_MS;
    while (!signal.aborted) {
      try {
        const response = await apiPost(this.fetchImpl, {
          baseUrl: this.baseUrl,
          endpoint: EP_GET_UPDATES,
          payload: { get_updates_buf: syncBuffer },
          token: this.opts.token,
          timeoutMs: timeoutMs + 5_000,
          signal,
        });
        const suggestedTimeout = numberValue(response, "longpolling_timeout_ms");
        if (suggestedTimeout && suggestedTimeout > 0) timeoutMs = suggestedTimeout;
        const ret = response.ret;
        const errcode = response.errcode;
        if ((ret !== undefined && ret !== 0) || (errcode !== undefined && errcode !== 0)) {
          if (ret === SESSION_EXPIRED_ERRCODE || errcode === SESSION_EXPIRED_ERRCODE || isStaleSession(ret, errcode, response.errmsg)) {
            this.ctx?.setStatus({ lastError: "wechat_session_expired" });
            await sleep(60_000, signal);
          } else {
            this.ctx?.setStatus({ lastError: `wechat_getupdates_failed:${String(errcode ?? ret)}` });
            await sleep(2_000, signal);
          }
          continue;
        }
        const nextSync = stringValue(response, "get_updates_buf");
        if (nextSync) {
          syncBuffer = nextSync;
          this.state.saveSyncBuffer(this.opts.accountId, syncBuffer);
        }
        const messages = Array.isArray(response.msgs) ? response.msgs : [];
        for (const msg of messages) {
          if (isRecord(msg)) {
            void this.processMessage(msg).catch((err) => {
              this.ctx?.setStatus({ lastError: err instanceof Error ? err.message : String(err) });
            });
          }
        }
      } catch (err) {
        if (signal.aborted) break;
        this.ctx?.setStatus({ lastError: err instanceof Error ? err.message : String(err) });
        await sleep(2_000, signal).catch(() => {});
      }
    }
  }

  private isDuplicate(key: string): boolean {
    const now = Date.now();
    for (const [k, expiresAt] of this.seen) {
      if (expiresAt <= now) this.seen.delete(k);
    }
    if (this.seen.has(key)) return true;
    this.seen.set(key, now + MESSAGE_DEDUP_TTL_MS);
    return false;
  }

  private async processMessage(message: Record<string, unknown>): Promise<void> {
    const senderId = stringValue(message, "from_user_id") || "";
    if (!senderId || senderId === this.opts.accountId) return;
    const messageId = stringValue(message, "message_id") || "";
    const text = extractText(message.item_list);
    if (!text) return;
    const { chatType, chatId } = guessChat(message, this.opts.accountId);
    if (chatType === "group") {
      if (this.groupPolicy === "disabled") return;
      if (this.groupPolicy === "allowlist" && !this.groupAllowlist.includes(chatId)) return;
    }
    if (messageId) {
      if (this.isDuplicate(`id:${messageId}`)) return;
    } else {
      const contentHash = createHash("sha1").update(`${senderId}:${chatId}:${text}`).digest("hex");
      if (this.isDuplicate(`content:${contentHash}`)) return;
    }
    const contextToken = stringValue(message, "context_token");
    if (contextToken) {
      this.state.setContextToken(this.opts.accountId, chatId, contextToken);
      if (chatId !== senderId) this.state.setContextToken(this.opts.accountId, senderId, contextToken);
    }
    const inbound: InboundMessage = {
      channel: "wechat",
      ...(messageId ? { messageId } : {}),
      channelUserId: senderId,
      channelChatId: chatId,
      channelChatType: chatType,
      parts: [{ type: "text", text }],
      raw: message,
    };
    await this.ctx?.emitInbound(inbound);
  }

  private async sendText(chatId: string, text: string): Promise<SendResult> {
    let lastMessageId: string | undefined;
    let contextToken = this.state.getContextToken(chatId);
    try {
      for (const chunk of splitText(text, this.maxMessageLength)) {
        const clientId = `easywork-wechat-${randomUUID()}`;
        let response = await sendIlinkText(this.fetchImpl, {
          baseUrl: this.baseUrl,
          token: this.opts.token,
          to: chatId,
          text: chunk,
          contextToken,
          clientId,
          signal: this.abort?.signal,
        });
        const ret = response.ret;
        const errcode = response.errcode;
        if ((ret === SESSION_EXPIRED_ERRCODE || errcode === SESSION_EXPIRED_ERRCODE || isStaleSession(ret, errcode, response.errmsg)) && contextToken) {
          this.state.deleteContextToken(this.opts.accountId, chatId);
          contextToken = undefined;
          response = await sendIlinkText(this.fetchImpl, {
            baseUrl: this.baseUrl,
            token: this.opts.token,
            to: chatId,
            text: chunk,
            clientId,
            signal: this.abort?.signal,
          });
        }
        const retryableRateLimit = response.ret === RATE_LIMIT_ERRCODE || response.errcode === RATE_LIMIT_ERRCODE;
        if (retryableRateLimit) {
          return { ok: false, error: "wechat_rate_limited", retryable: true };
        }
        if ((response.ret !== undefined && response.ret !== 0) || (response.errcode !== undefined && response.errcode !== 0)) {
          return { ok: false, error: `wechat_send_failed:${String(response.errcode ?? response.ret)}`, retryable: false };
        }
        lastMessageId = clientId;
        await sleep(300, this.abort?.signal);
      }
      return { ok: true, ...(lastMessageId ? { messageId: lastMessageId } : {}) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), retryable: true };
    }
  }
}

export const wechatAdapterMeta: ChannelAdapterMeta = {
  kind: "wechat",
  label: "WeChat",
  description: "Personal WeChat via Tencent iLink Bot API QR login and long-polling",
  requiredSecrets: [{ key: "token", label: "iLink Bot Token", password: true }],
  optionalSecrets: [],
  supportsWebhook: false,
  supportsStreamingEdit: false,
  supportsAttachments: false,
  maxMessageLength: 2_000,
};

function stringArrayOption(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === "string") return value.split(/[\n,]/).map((v) => v.trim()).filter(Boolean);
  return [];
}

function groupPolicyOption(value: unknown): WechatGroupPolicy {
  return value === "open" || value === "allowlist" ? value : "disabled";
}

export const wechatAdapterEntry = {
  meta: wechatAdapterMeta,
  create(config) {
    return new WechatChannelAdapter({
      accountId: typeof config.options.accountId === "string" ? config.options.accountId : String(config.secrets.accountId ?? ""),
      token: config.secrets.token ?? "",
      baseUrl: typeof config.options.baseUrl === "string" ? config.options.baseUrl : undefined,
      stateDir: typeof config.options.stateDir === "string" ? config.options.stateDir : undefined,
      groupPolicy: groupPolicyOption(config.options.groupPolicy),
      groupAllowlist: stringArrayOption(config.options.groupAllowlist),
      pollTimeoutMs: typeof config.options.pollTimeoutMs === "number" ? config.options.pollTimeoutMs : undefined,
      maxMessageLength: typeof config.options.maxMessageLength === "number" ? config.options.maxMessageLength : undefined,
    });
  },
} satisfies import("./adapter.js").ChannelAdapterEntry;
