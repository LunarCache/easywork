import { describe, it, expect } from "vitest";
import { createCipheriv, createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  messageText,
  type AgentEvent,
  type AgentRunInput,
  type ChannelKind,
  type ChannelOutbound,
  type ChannelConnector,
  type ConversationRepo,
  type InboundMessage,
  type MessageSearchHit,
  type OutboundChunk,
  type Project,
  type StoredMessage,
  type Thread,
} from "@ew/shared";
import { ConnectorHost } from "../src/host.js";
import { ChannelGateway } from "../src/gateway.js";
import { ChannelAdapterRegistry } from "../src/registry.js";
import type { ChannelAdapter, ChannelAdapterContext, SendResult } from "../src/adapter.js";
import { FeishuChannelAdapter, calculateFeishuSignature, type FeishuSdkChannel, type FeishuSdkMessage } from "../src/feishu.js";
import { TelegramConnector } from "../src/telegram.js";
import { registerWechatAccount, WechatChannelAdapter } from "../src/wechat.js";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function waitFor(assertion: () => void | boolean): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i < 40; i++) {
    try {
      const result = assertion();
      if (result !== false) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (lastErr) throw lastErr;
  throw new Error("condition not met");
}

function encryptFeishuPayload(payload: unknown, encryptKey: string): string {
  const key = createHash("sha256").update(encryptKey, "utf8").digest();
  const iv = Buffer.from("1234567890abcdef");
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([
    iv,
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]).toString("base64");
}

function textFromPart(part: InboundMessage["parts"][number] | undefined): string | undefined {
  return part?.type === "text" ? part.text : undefined;
}

/** 内存版会话仓库（测试用）。 */
class FakeRepo implements ConversationRepo {
  private threads = new Map<string, Thread>();
  private msgs = new Map<string, StoredMessage[]>();
  private channelMap = new Map<string, string>();
  private projects = new Map<string, Project>();
  private n = 0;
  createProject(p: Partial<Project> & { name: string }): Project {
    const id = p.id ?? `p${++this.n}`;
    const proj: Project = { id, name: p.name, createdAt: new Date().toISOString() };
    this.projects.set(id, proj);
    return proj;
  }
  getProject(id: string): Project | null {
    return this.projects.get(id) ?? null;
  }
  listProjects(): Project[] {
    return [...this.projects.values()];
  }
  updateProject(id: string, patch: Partial<Project>): Project {
    const cur = this.projects.get(id)!;
    const next = { ...cur, ...patch };
    this.projects.set(id, next);
    return next;
  }
  deleteProject(id: string): void {
    this.projects.delete(id);
  }
  searchMessages(): MessageSearchHit[] {
    return [];
  }
  createThread(t: Partial<Thread>): Thread {
    const id = t.id ?? `t${++this.n}`;
    const now = new Date().toISOString();
    const thread: Thread = { id, title: t.title ?? "", modelId: t.modelId ?? "", createdAt: now, updatedAt: now, ...(t.channel ? { channel: t.channel } : {}) };
    this.threads.set(id, thread);
    this.msgs.set(id, []);
    return thread;
  }
  getThread(id: string): Thread | null {
    return this.threads.get(id) ?? null;
  }
  listThreads(): Thread[] {
    return [...this.threads.values()];
  }
  nextSeq(threadId: string): number {
    return (this.msgs.get(threadId)?.length ?? 0);
  }
  appendMessage(m: StoredMessage): void {
    this.msgs.get(m.threadId)?.push(m);
  }
  history(threadId: string): StoredMessage[] {
    return this.msgs.get(threadId) ?? [];
  }
  resolveThreadForChannel(kind: ChannelKind, userId: string): Thread {
    const key = `${kind}:${userId}`;
    const existing = this.channelMap.get(key);
    if (existing) return this.threads.get(existing)!;
    const t = this.createThread({ channel: { kind, channelId: userId } });
    this.channelMap.set(key, t.id);
    return t;
  }
}

/** 假连接器：记录回复，可手动触发入站。 */
class FakeConnector implements ChannelConnector {
  readonly kind = "inapp" as const;
  replies: string[] = [];
  private handler?: (m: InboundMessage) => Promise<void>;
  onInbound(h: (m: InboundMessage) => Promise<void>): void {
    this.handler = h;
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async reply(_t: { channelChatId: string }, stream: AsyncIterable<OutboundChunk>): Promise<void> {
    let s = "";
    for await (const c of stream) if (c.text) s += c.text;
    this.replies.push(s);
  }
  trigger(m: InboundMessage): Promise<void> {
    return this.handler!(m);
  }
}

describe("ConnectorHost", () => {
  it("inbound → 路由到同一大脑 → 回复 → 持久化", async () => {
    const repo = new FakeRepo();
    const persisted: { threadId: string; role: "user" | "assistant" }[] = [];
    const run = async function* (input: AgentRunInput): AsyncIterable<AgentEvent> {
      const last = input.history[input.history.length - 1];
      const text = `echo: ${last ? messageText(last.content) : ""}`;
      yield { type: "text", text };
      yield { type: "final", message: { role: "assistant", content: text } };
    };
    const host = new ConnectorHost({
      repo,
      run,
      defaultModel: "m",
      onMessagePersisted: (info) => persisted.push({ threadId: info.threadId, role: info.role }),
    });
    const conn = new FakeConnector();
    host.attach(conn);

    await conn.trigger({
      channel: "inapp",
      channelUserId: "u1",
      channelChatId: "c1",
      parts: [{ type: "text", text: "你好" }],
    });

    expect(conn.replies).toEqual(["echo: 你好"]);
    // 同一渠道用户映射到同一 thread，且消息已持久化（user + assistant）。
    const threads = repo.listThreads();
    expect(threads).toHaveLength(1);
    expect(repo.history(threads[0]!.id).map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(persisted).toEqual([
      { threadId: threads[0]!.id, role: "user" },
      { threadId: threads[0]!.id, role: "assistant" },
    ]);
  });
});

describe("TelegramConnector", () => {
  it("pollOnce 解析 getUpdates → 触发 inbound，并推进 offset", async () => {
    const calls: { method: string; body: Record<string, unknown> }[] = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      const method = url.split("/").pop()!;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ method, body });
      if (method === "getUpdates") {
        return new Response(
          JSON.stringify({
            result: [{ update_id: 10, message: { from: { id: 7 }, chat: { id: 77 }, text: "hello" } }],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const tg = new TelegramConnector({ token: "x", fetch: fakeFetch });
    const inbound: InboundMessage[] = [];
    tg.onInbound(async (m) => {
      inbound.push(m);
    });
    const n = await tg.pollOnce();
    expect(n).toBe(1);
    expect(inbound[0]!.channelUserId).toBe("7");
    expect(inbound[0]!.channelChatId).toBe("77");
    expect(textFromPart(inbound[0]!.parts[0])).toBe("hello");
    // 下一次 getUpdates offset 应为 11
    await tg.pollOnce();
    expect(calls.filter((c) => c.method === "getUpdates")[1]!.body.offset).toBe(11);
  });

  it("reply 累积文本后 sendMessage", async () => {
    const sent: Record<string, unknown>[] = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      const method = url.split("/").pop()!;
      if (method === "sendMessage") sent.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const tg = new TelegramConnector({ token: "x", fetch: fakeFetch });
    async function* chunks(): AsyncIterable<OutboundChunk> {
      yield { text: "hi " };
      yield { text: "there" };
      yield { final: true };
    }
    await tg.reply({ channelChatId: "77" }, chunks());
    expect(sent).toHaveLength(1);
    expect(sent[0].chat_id).toBe("77");
    expect(sent[0].text).toBe("hi there");
  });

  it("stop 会取消正在进行的 long-poll", async () => {
    let aborted = false;
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }) as unknown as typeof fetch;
    const tg = new TelegramConnector({ token: "x", fetch: fakeFetch, pollTimeout: 25 });

    const running = tg.start();
    await new Promise((r) => setTimeout(r, 0));
    await tg.stop();
    await running;

    expect(aborted).toBe(true);
  });
});

describe("FeishuChannelAdapter", () => {
  it("rejects public webhooks unless webhook transport and a webhook secret are configured", async () => {
    const websocketAdapter = new FeishuChannelAdapter({
      appId: "cli_a",
      appSecret: "secret",
    });
    const websocketWebhook = await websocketAdapter.handleWebhook({
      method: "POST",
      path: "/im/fs/webhook",
      query: {},
      headers: {},
      body: { type: "url_verification", challenge: "challenge-1" },
    });
    expect(websocketWebhook).toEqual({ status: 404, body: { error: "feishu_webhook_not_enabled" } });

    const unsignedWebhookAdapter = new FeishuChannelAdapter({
      appId: "cli_a",
      appSecret: "secret",
      transport: "webhook",
    });
    const unsignedWebhook = await unsignedWebhookAdapter.handleWebhook({
      method: "POST",
      path: "/im/fs/webhook",
      query: {},
      headers: {},
      body: { type: "url_verification", challenge: "challenge-1" },
    });
    expect(unsignedWebhook).toEqual({ status: 401, body: { error: "feishu_webhook_secret_required" } });
  });

  it("handles URL verification and rejects token mismatches", async () => {
    const adapter = new FeishuChannelAdapter({
      appId: "cli_a",
      appSecret: "secret",
      verificationToken: "vt",
      transport: "webhook",
    });

    const ok = await adapter.handleWebhook({
      method: "POST",
      path: "/im/fs/webhook",
      query: {},
      headers: {},
      body: { type: "url_verification", token: "vt", challenge: "challenge-1" },
    });
    expect(ok).toEqual({ body: { challenge: "challenge-1" } });

    const bad = await adapter.handleWebhook({
      method: "POST",
      path: "/im/fs/webhook",
      query: {},
      headers: {},
      body: { type: "url_verification", token: "wrong", challenge: "challenge-1" },
    });
    expect(bad).toEqual({ status: 401, body: { error: "feishu_verification_token_invalid" } });
  });

  it("verifies signatures and normalizes text message callbacks", async () => {
    const inbound: InboundMessage[] = [];
    const adapter = new FeishuChannelAdapter({
      appId: "cli_a",
      appSecret: "secret",
      verificationToken: "vt",
      encryptKey: "ek",
      transport: "webhook",
    });
    await adapter.start({
      config: {
        id: "fs-main",
        kind: "feishu",
        enabled: true,
        secrets: {},
        options: {},
        auth: { allowAll: true },
      },
      emitInbound: async (message) => {
        inbound.push(message);
      },
      setStatus: () => {},
    });

    const body = {
      schema: "2.0",
      header: { event_type: "im.message.receive_v1", token: "vt" },
      event: {
        sender: {
          sender_type: "user",
          sender_id: { open_id: "ou_1", user_id: "u_1" },
          sender_name: "Ada",
        },
        message: {
          message_id: "om_1",
          chat_id: "oc_1",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "hello feishu" }),
        },
      },
    };
    const raw = JSON.stringify(body);
    const signature = calculateFeishuSignature("111", "nonce", "ek", raw);

    const res = await adapter.handleWebhook({
      method: "POST",
      path: "/im/fs/webhook",
      query: {},
      headers: {
        "x-lark-request-timestamp": "111",
        "x-lark-request-nonce": "nonce",
        "x-lark-signature": signature,
      },
      body,
      rawBody: raw,
    });

    expect(res).toEqual({ body: { ok: true } });
    expect(inbound).toEqual([
      expect.objectContaining({
        channel: "feishu",
        messageId: "om_1",
        channelUserId: "ou_1",
        channelUserName: "Ada",
        channelChatId: "oc_1",
        channelChatType: "dm",
        parts: [{ type: "text", text: "hello feishu" }],
      }),
    ]);

    const denied = await adapter.handleWebhook({
      method: "POST",
      path: "/im/fs/webhook",
      query: {},
      headers: {
        "x-lark-request-timestamp": "111",
        "x-lark-request-nonce": "nonce",
        "x-lark-signature": "bad",
      },
      body,
      rawBody: raw,
    });
    expect(denied).toEqual({ status: 401, body: { error: "feishu_signature_invalid" } });
  });

  it("decrypts encrypted callback payloads", async () => {
    const adapter = new FeishuChannelAdapter({
      appId: "cli_a",
      appSecret: "secret",
      verificationToken: "vt",
      encryptKey: "ek",
      transport: "webhook",
    });
    const body = {
      encrypt: encryptFeishuPayload({ type: "url_verification", token: "vt", challenge: "enc-challenge" }, "ek"),
    };
    const raw = JSON.stringify(body);
    const res = await adapter.handleWebhook({
      method: "POST",
      path: "/im/fs/webhook",
      query: {},
      headers: {
        "x-lark-request-timestamp": "111",
        "x-lark-request-nonce": "nonce",
        "x-lark-signature": calculateFeishuSignature("111", "nonce", "ek", raw),
      },
      body,
      rawBody: raw,
    });

    expect(res).toEqual({ body: { challenge: "enc-challenge" } });
  });

  it("sends text through tenant access token and message APIs", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ url: href, body });
      if (href.endsWith("/open-apis/auth/v3/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token", expire: 7200 }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: 0, data: { message_id: "om_out" } }), { status: 200 });
    }) as unknown as typeof fetch;

    const adapter = new FeishuChannelAdapter({
      appId: "cli_a",
      appSecret: "secret",
      transport: "webhook",
      baseUrl: "https://feishu.test",
      fetch: fakeFetch,
    });

    const res = await adapter.send({ channelChatId: "oc_1" }, { text: "hello" });

    expect(res).toEqual({ ok: true, messageId: "om_out" });
    expect(calls[0]).toMatchObject({
      url: "https://feishu.test/open-apis/auth/v3/tenant_access_token/internal",
      body: { app_id: "cli_a", app_secret: "secret" },
    });
    expect(calls[1]).toMatchObject({
      url: "https://feishu.test/open-apis/im/v1/messages?receive_id_type=chat_id",
      body: {
        receive_id: "oc_1",
        msg_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    });
  });

  it("uses WebSocket channel by default and routes normalized messages", async () => {
    class FakeFeishuChannel implements FeishuSdkChannel {
      connected = false;
      disconnected = false;
      sent: Array<{ to: string; input: { text: string }; opts?: { replyTo?: string } }> = [];
      private messageHandler?: (msg: FeishuSdkMessage) => void | Promise<void>;
      async connect(): Promise<void> {
        this.connected = true;
      }
      async disconnect(): Promise<void> {
        this.disconnected = true;
      }
      on(name: "message" | "error" | "reconnecting" | "reconnected" | "reject", handler: (event: unknown) => void | Promise<void>): () => void {
        if (name === "message") this.messageHandler = handler as (msg: FeishuSdkMessage) => void | Promise<void>;
        return () => {
          if (name === "message") this.messageHandler = undefined;
        };
      }
      async send(to: string, input: { text: string }, opts?: { replyTo?: string }): Promise<{ messageId?: string }> {
        this.sent.push({ to, input, ...(opts ? { opts } : {}) });
        return { messageId: "om_ws" };
      }
      emit(message: FeishuSdkMessage): Promise<void> {
        return Promise.resolve(this.messageHandler?.(message));
      }
    }

    const fakeChannel = new FakeFeishuChannel();
    const inbound: InboundMessage[] = [];
    const status: Record<string, unknown>[] = [];
    const adapter = new FeishuChannelAdapter({
      appId: "cli_a",
      appSecret: "secret",
      sdkChannelFactory: () => fakeChannel,
    });

    await adapter.start({
      config: {
        id: "fs-main",
        kind: "feishu",
        enabled: true,
        secrets: {},
        options: {},
        auth: { allowAll: true },
      },
      emitInbound: async (message) => {
        inbound.push(message);
      },
      setStatus: (patch) => {
        status.push(patch);
      },
    });

    await fakeChannel.emit({
      messageId: "om_1",
      chatId: "oc_1",
      chatType: "group",
      senderId: "ou_1",
      senderName: "Ada",
      content: "hello websocket",
      rawContentType: "text",
      rootId: "om_root",
    });
    const sent = await adapter.send({ channelChatId: "oc_1", replyToMessageId: "om_1" }, { text: "hi" });
    await adapter.stop();

    expect(fakeChannel.connected).toBe(true);
    expect(fakeChannel.disconnected).toBe(true);
    expect(status).toContainEqual({ running: true, lastError: undefined });
    expect(inbound).toEqual([
      expect.objectContaining({
        channel: "feishu",
        messageId: "om_1",
        channelUserId: "ou_1",
        channelUserName: "Ada",
        channelChatId: "oc_1",
        channelChatType: "group",
        channelThreadId: "om_root",
        parts: [{ type: "text", text: "hello websocket" }],
      }),
    ]);
    expect(sent).toEqual({ ok: true, messageId: "om_ws" });
    expect(fakeChannel.sent).toEqual([{ to: "oc_1", input: { text: "hi" }, opts: { replyTo: "om_1" } }]);
  });
});

describe("WechatChannelAdapter", () => {
  it("QR registration polls iLink and returns connector credentials", async () => {
    const seenStatuses: string[] = [];
    let qrUrl = "";
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("get_bot_qrcode")) {
        return jsonResponse({ qrcode: "qr-token", qrcode_img_content: "https://weixin.example/qr" });
      }
      if (url.includes("get_qrcode_status")) {
        return jsonResponse({
          status: "confirmed",
          ilink_bot_id: "bot-1",
          bot_token: "token-1",
          baseurl: "https://ilink.example",
          ilink_user_id: "wxid_me",
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    };

    const result = await registerWechatAccount({
      fetch: fetchImpl,
      timeoutMs: 2_000,
      onQRCodeReady: (info) => {
        qrUrl = info.url;
      },
      onStatusChange: (info) => {
        seenStatuses.push(info.status);
      },
    });

    expect(qrUrl).toBe("https://weixin.example/qr");
    expect(seenStatuses).toEqual(["confirmed"]);
    expect(result).toEqual({
      accountId: "bot-1",
      token: "token-1",
      baseUrl: "https://ilink.example",
      userId: "wxid_me",
    });
  });

  it("long-polls inbound text and sends replies with stored context_token", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ew-wechat-"));
    const inbound: InboundMessage[] = [];
    const sendBodies: Record<string, unknown>[] = [];
    let updates = 0;
    let adapter: WechatChannelAdapter | undefined;
    try {
      const fetchImpl: typeof fetch = async (input, init) => {
        const url = String(input);
        if (url.includes("getupdates")) {
          updates += 1;
          if (updates === 1) {
            return jsonResponse({
              ret: 0,
              get_updates_buf: "sync-1",
              msgs: [{
                message_id: "m-1",
                from_user_id: "wxid_1",
                to_user_id: "bot-1",
                item_list: [{ type: 1, text_item: { text: "hello" } }],
                context_token: "ctx-1",
              }],
            });
          }
          await new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
          return jsonResponse({ ret: 0, msgs: [] });
        }
        if (url.includes("sendmessage")) {
          sendBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return jsonResponse({ ret: 0 });
        }
        throw new Error(`unexpected fetch ${url}`);
      };

      adapter = new WechatChannelAdapter({
        accountId: "bot-1",
        token: "token-1",
        stateDir,
        fetch: fetchImpl,
      });
      await adapter.start({
        config: { id: "wechat-main", kind: "wechat", enabled: true, secrets: {}, options: {}, auth: { allowAll: true } },
        emitInbound: async (message) => {
          inbound.push(message);
        },
        setStatus: () => {},
      });
      await waitFor(() => expect(inbound).toHaveLength(1));
      expect(inbound[0]).toMatchObject({
        channel: "wechat",
        channelUserId: "wxid_1",
        channelChatId: "wxid_1",
        parts: [{ type: "text", text: "hello" }],
      });

      const sent = await adapter.send({ channelChatId: "wxid_1" }, { text: "hi back" });
      expect(sent).toMatchObject({ ok: true });
      expect(sendBodies).toHaveLength(1);
      const msg = sendBodies[0]!.msg as Record<string, unknown>;
      expect(msg.context_token).toBe("ctx-1");
      expect(msg.to_user_id).toBe("wxid_1");
    } finally {
      await adapter?.stop();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("keeps repeated inbound text when WeChat provides distinct message ids", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ew-wechat-"));
    const inbound: InboundMessage[] = [];
    let updates = 0;
    let adapter: WechatChannelAdapter | undefined;
    try {
      const fetchImpl: typeof fetch = async (input, init) => {
        const url = String(input);
        if (url.includes("getupdates")) {
          updates += 1;
          if (updates === 1) {
            return jsonResponse({
              ret: 0,
              get_updates_buf: "sync-1",
              msgs: [
                {
                  message_id: "m-repeat-1",
                  from_user_id: "wxid_1",
                  to_user_id: "bot-1",
                  item_list: [{ type: 1, text_item: { text: "ping" } }],
                },
                {
                  message_id: "m-repeat-2",
                  from_user_id: "wxid_1",
                  to_user_id: "bot-1",
                  item_list: [{ type: 1, text_item: { text: "ping" } }],
                },
                {
                  message_id: "m-repeat-2",
                  from_user_id: "wxid_1",
                  to_user_id: "bot-1",
                  item_list: [{ type: 1, text_item: { text: "ping" } }],
                },
              ],
            });
          }
          await new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
          return jsonResponse({ ret: 0, msgs: [] });
        }
        throw new Error(`unexpected fetch ${url}`);
      };

      adapter = new WechatChannelAdapter({
        accountId: "bot-1",
        token: "token-1",
        stateDir,
        fetch: fetchImpl,
      });
      await adapter.start({
        config: { id: "wechat-main", kind: "wechat", enabled: true, secrets: {}, options: {}, auth: { allowAll: true } },
        emitInbound: async (message) => {
          inbound.push(message);
        },
        setStatus: () => {},
      });
      await waitFor(() => expect(inbound).toHaveLength(2));
      expect(inbound.map((message) => message.messageId)).toEqual(["m-repeat-1", "m-repeat-2"]);
      expect(inbound.map((message) => message.parts[0])).toEqual([
        { type: "text", text: "ping" },
        { type: "text", text: "ping" },
      ]);
    } finally {
      await adapter?.stop();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe("ChannelGateway", () => {
  it("registry adapter：启动、转发 inbound、发送 reply、记录状态", async () => {
    class TestAdapter implements ChannelAdapter {
      readonly kind = "telegram" as const;
      readonly meta = {
        kind: "telegram" as const,
        label: "Test Telegram",
        requiredSecrets: [{ key: "token", label: "Token" }],
      };
      ctx?: ChannelAdapterContext;
      sent: { target: { channelChatId: string; channelThreadId?: string; replyToMessageId?: string }; message: ChannelOutbound }[] = [];
      async start(ctx: ChannelAdapterContext): Promise<void> {
        this.ctx = ctx;
      }
      async stop(): Promise<void> {}
      async send(target: { channelChatId: string; channelThreadId?: string; replyToMessageId?: string }, message: ChannelOutbound): Promise<SendResult> {
        this.sent.push({ target, message });
        return { ok: true };
      }
      trigger(message: InboundMessage): Promise<void> {
        return this.ctx!.emitInbound(message);
      }
    }

    const adapter = new TestAdapter();
    const registry = new ChannelAdapterRegistry();
    registry.register({ meta: adapter.meta, create: () => adapter });
    const inbound: InboundMessage[] = [];
    const gateway = new ChannelGateway({
      registry,
      configs: [{ id: "tg-main", kind: "telegram", enabled: true, secrets: { token: "x" }, options: {}, auth: { allowAll: true } }],
      handleInbound: async (message) => {
        inbound.push(message);
      },
    });

    await gateway.startAll();
    await adapter.trigger({
      channel: "telegram",
      channelUserId: "u1",
      channelChatId: "c1",
      channelThreadId: "topic-1",
      messageId: "msg-1",
      parts: [{ type: "text", text: "hello" }],
    });
    await gateway.reply("tg-main", { channelChatId: "c1", channelThreadId: "topic-1", replyToMessageId: "msg-1" }, (async function* () {
      yield { text: "hi " };
      yield { text: "there", final: true };
    })());

    expect(inbound).toHaveLength(1);
    expect(adapter.sent).toEqual([
      {
        target: { channelChatId: "c1", channelThreadId: "topic-1", replyToMessageId: "msg-1" },
        message: { text: "hi there", attachments: [] },
      },
    ]);
    expect(gateway.statuses()[0]).toMatchObject({ id: "tg-main", running: true });
  });

  it("按连接器 allowlist 过滤入站消息", async () => {
    class TestAdapter implements ChannelAdapter {
      readonly kind = "telegram" as const;
      readonly meta = {
        kind: "telegram" as const,
        label: "Test Telegram",
        requiredSecrets: [{ key: "token", label: "Token" }],
      };
      ctx?: ChannelAdapterContext;
      async start(ctx: ChannelAdapterContext): Promise<void> {
        this.ctx = ctx;
      }
      async stop(): Promise<void> {}
      async send(): Promise<SendResult> {
        return { ok: true };
      }
      trigger(message: InboundMessage): Promise<void> {
        return this.ctx!.emitInbound(message);
      }
    }

    const adapter = new TestAdapter();
    const registry = new ChannelAdapterRegistry();
    registry.register({ meta: adapter.meta, create: () => adapter });
    const inbound: InboundMessage[] = [];
    const gateway = new ChannelGateway({
      registry,
      configs: [{
        id: "tg-main",
        kind: "telegram",
        enabled: true,
        secrets: { token: "x" },
        options: {},
        auth: { allowedUsers: ["u-ok"] },
      }],
      handleInbound: async (message) => {
        inbound.push(message);
      },
    });

    await gateway.startAll();
    await adapter.trigger({
      channel: "telegram",
      channelUserId: "u-no",
      channelChatId: "c1",
      parts: [{ type: "text", text: "blocked" }],
    });
    await adapter.trigger({
      channel: "telegram",
      channelUserId: "u-ok",
      channelChatId: "c1",
      parts: [{ type: "text", text: "allowed" }],
    });

    expect(inbound.map((m) => textFromPart(m.parts[0]))).toEqual(["allowed"]);
    expect(gateway.statuses()[0]).toMatchObject({ running: true });
  });
});
