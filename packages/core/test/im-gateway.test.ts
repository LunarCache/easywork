import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCore, type CoreServer } from "../src/server/app.js";
import { MemoryChannelSecretStore } from "../src/channels/secret-store.js";
import { SqliteConversationRepo } from "../src/store/conversation.js";

const auth = { authorization: "Bearer t" };

function tempDb(): { dir: string; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ew-im-"));
  return { dir, dbPath: path.join(dir, "conv.db") };
}

function feishuSignature(timestamp: string, nonce: string, encryptKey: string, body: string): string {
  return createHash("sha256").update(timestamp + nonce + encryptKey).update(body).digest("hex");
}

function makeSseReader(reader: ReadableStreamDefaultReader<Uint8Array>): () => Promise<unknown> {
  const decoder = new TextDecoder();
  let buffer = "";
  return async () => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error("sse stream ended");
      buffer += decoder.decode(value, { stream: true });
      const idx = buffer.indexOf("\n\n");
      if (idx === -1) continue;
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const line = frame.split(/\r?\n/).find((item) => item.startsWith("data:"));
      if (!line) continue;
      return JSON.parse(line.replace(/^data:\s?/, "")) as unknown;
    }
  };
}

describe("IM ChannelGateway HTTP routes", () => {
  let core: CoreServer | undefined;
  const cleanup: string[] = [];

  afterEach(async () => {
    await core?.stop();
    core = undefined;
    for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("lists built-in channel adapters", async () => {
    core = createCore({ token: "t", dbPath: ":memory:", memoryDbPath: ":memory:" });
    const res = await core.app.inject({ method: "GET", url: "/im/adapters", headers: auth });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { adapters: { kind: string; label: string; supportsWebhook?: boolean }[] };
    expect(body.adapters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "telegram",
          label: "Telegram",
          supportsWebhook: false,
        }),
        expect.objectContaining({
          kind: "feishu",
          label: "Feishu / Lark",
          supportsWebhook: true,
        }),
        expect.objectContaining({
          kind: "wechat",
          label: "WeChat",
          supportsWebhook: false,
        }),
      ]),
    );
  });

  it("lists channel threads as inbox conversations", async () => {
    core = createCore({ token: "t", dbPath: ":memory:", memoryDbPath: ":memory:" });
    const channelThread = core.repo.resolveThreadForChannel("wechat", "wxid_alice", { modelId: "model-a" });
    core.repo.appendMessage({
      id: "msg-channel-1",
      threadId: channelThread.id,
      role: "user",
      seq: 0,
      parts: [{ type: "text", text: "来自微信的消息" }],
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const plainThread = core.repo.createThread({ id: "plain-chat", title: "普通对话", modelId: "model-a" });
    core.repo.appendMessage({
      id: "msg-plain-1",
      threadId: plainThread.id,
      role: "user",
      seq: 0,
      parts: [{ type: "text", text: "普通聊天消息" }],
      createdAt: "2026-01-01T00:01:00.000Z",
    });

    const res = await core.app.inject({ method: "GET", url: "/inbox/threads", headers: auth });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      threads: [
        {
          id: channelThread.id,
          title: "wechat:wxid_alice",
          channel: { kind: "wechat", channelId: "wxid_alice" },
          modelId: "model-a",
          messageCount: 1,
          lastMessage: { role: "user", text: "来自微信的消息" },
        },
      ],
    });
  });

  it("streams inbox invalidation events over SSE", async () => {
    core = createCore({ token: "t", dbPath: ":memory:", memoryDbPath: ":memory:" });
    const { host, port } = await core.start({ host: "127.0.0.1", port: 0 });
    const ac = new AbortController();
    const res = await fetch(`http://${host}:${port}/inbox/events`, {
      headers: auth,
      signal: ac.signal,
    });
    expect(res.status).toBe(200);
    expect(res.body).toBeTruthy();
    const reader = res.body!.getReader();
    const nextEvent = makeSseReader(reader);
    try {
      expect(await nextEvent()).toMatchObject({ type: "ready" });

      const upsert = await fetch(`http://${host}:${port}/im/connectors`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({
          id: "tg-main",
          kind: "telegram",
          enabled: false,
          secrets: { token: "test-token" },
          options: {},
          auth: { allowAll: true },
        }),
      });
      expect(upsert.status).toBe(200);

      expect(await nextEvent()).toMatchObject({
        type: "changed",
        reason: "connector",
      });
    } finally {
      ac.abort();
      await reader.cancel().catch(() => {});
    }
  });

  it("persists connector configs and restores them on the next core instance", async () => {
    const { dir, dbPath } = tempDb();
    cleanup.push(dir);
    const channelSecretStore = new MemoryChannelSecretStore();

    core = createCore({ token: "t", dbPath, memoryDbPath: ":memory:", channelSecretStore });
    const upsert = await core.app.inject({
      method: "POST",
      url: "/im/connectors",
      headers: { ...auth, "content-type": "application/json" },
      payload: {
        id: "tg-main",
        kind: "telegram",
        enabled: false,
        displayName: "Main bot",
        secrets: { token: "test-token" },
        options: { pollTimeout: 1 },
        auth: { allowedUsers: ["42"] },
      },
    });
    expect(upsert.statusCode).toBe(200);
    expect(upsert.json()).toMatchObject({
      ok: true,
      status: { id: "tg-main", kind: "telegram", enabled: false, running: false },
    });

    const listed = await core.app.inject({ method: "GET", url: "/im/connectors", headers: auth });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      connectors: [
        {
          id: "tg-main",
          kind: "telegram",
          enabled: false,
          displayName: "Main bot",
          secrets: {},
          secretKeys: ["token"],
          options: { pollTimeout: 1 },
          auth: { allowedUsers: ["42"] },
        },
      ],
      status: [expect.objectContaining({ id: "tg-main", running: false })],
    });
    expect(channelSecretStore.get("tg-main")).toEqual({ token: "test-token" });
    expect(core.repo.getSetting("im.connectors")).not.toContain("test-token");

    const metadataOnlyUpdate = await core.app.inject({
      method: "POST",
      url: "/im/connectors",
      headers: { ...auth, "content-type": "application/json" },
      payload: {
        id: "tg-main",
        kind: "telegram",
        enabled: false,
        displayName: "Renamed bot",
        secrets: {},
        options: { pollTimeout: 2 },
        auth: { allowedUsers: ["42"] },
      },
    });
    expect(metadataOnlyUpdate.statusCode).toBe(200);
    expect(channelSecretStore.get("tg-main")).toEqual({ token: "test-token" });

    await core.stop();
    core = createCore({ token: "t", dbPath, memoryDbPath: ":memory:", channelSecretStore });
    const restored = await core.app.inject({ method: "GET", url: "/im/connectors", headers: auth });

    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({
      connectors: [expect.objectContaining({ id: "tg-main", kind: "telegram", displayName: "Renamed bot", secrets: {}, secretKeys: ["token"] })],
      status: [expect.objectContaining({ id: "tg-main", running: false })],
    });

    const removed = await core.app.inject({ method: "DELETE", url: "/im/connectors/tg-main", headers: auth });
    expect(removed.statusCode).toBe(200);
    expect(channelSecretStore.get("tg-main")).toEqual({});
  });

  it("migrates legacy connector secrets out of SQLite on startup", async () => {
    const { dir, dbPath } = tempDb();
    cleanup.push(dir);
    const legacyRepo = new SqliteConversationRepo(dbPath);
    legacyRepo.setSetting("im.connectors", JSON.stringify([{
      id: "legacy-feishu",
      kind: "feishu",
      enabled: false,
      secrets: { appId: "cli_legacy", appSecret: "legacy-secret" },
      options: { transport: "websocket" },
      auth: { allowAll: true },
    }]));
    legacyRepo.close();
    const channelSecretStore = new MemoryChannelSecretStore();

    core = createCore({ token: "t", dbPath, memoryDbPath: ":memory:", channelSecretStore });

    expect(channelSecretStore.get("legacy-feishu")).toEqual({ appId: "cli_legacy", appSecret: "legacy-secret" });
    const persisted = core.repo.getSetting("im.connectors") ?? "";
    expect(persisted).not.toContain("cli_legacy");
    expect(persisted).not.toContain("legacy-secret");
    expect(JSON.parse(persisted)).toEqual([
      expect.objectContaining({ id: "legacy-feishu", secrets: {} }),
    ]);
    expect(persisted).not.toContain("secretKeys");

    const listed = await core.app.inject({ method: "GET", url: "/im/connectors", headers: auth });
    expect(listed.json()).toMatchObject({
      connectors: [expect.objectContaining({ id: "legacy-feishu", secrets: {}, secretKeys: ["appId", "appSecret"] })],
    });
  });

  it("requires bearer auth and returns adapter webhook result", async () => {
    core = createCore({ token: "t", dbPath: ":memory:", memoryDbPath: ":memory:" });
    const unauthorized = await core.app.inject({ method: "GET", url: "/im/adapters" });
    expect(unauthorized.statusCode).toBe(401);

    const upsert = await core.app.inject({
      method: "POST",
      url: "/im/connectors",
      headers: { ...auth, "content-type": "application/json" },
      payload: {
        id: "tg-main",
        kind: "telegram",
        enabled: false,
        secrets: { token: "test-token" },
        options: {},
        auth: { allowAll: true },
      },
    });
    expect(upsert.statusCode).toBe(200);

    const webhook = await core.app.inject({
      method: "POST",
      url: "/im/tg-main/webhook?source=test",
      headers: { "content-type": "application/json" },
      payload: { update_id: 1 },
    });
    expect(webhook.statusCode).toBe(404);
    expect(webhook.json()).toEqual({ error: "webhook_not_supported" });

    const missing = await core.app.inject({
      method: "POST",
      url: "/im/missing/webhook",
      headers: { "content-type": "application/json" },
      payload: {},
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: "unknown_channel_connector" });
  });

  it("dispatches signed Feishu webhook callbacks without daemon bearer auth", async () => {
    core = createCore({ token: "t", dbPath: ":memory:", memoryDbPath: ":memory:" });
    const upsert = await core.app.inject({
      method: "POST",
      url: "/im/connectors",
      headers: { ...auth, "content-type": "application/json" },
      payload: {
        id: "fs-main",
        kind: "feishu",
        enabled: false,
        secrets: {
          appId: "cli_a",
          appSecret: "secret",
          verificationToken: "vt",
          encryptKey: "ek",
        },
        options: { transport: "webhook" },
        auth: { allowAll: true },
      },
    });
    expect(upsert.statusCode).toBe(200);

    const payload = { type: "url_verification", token: "vt", challenge: "challenge-1" };
    const raw = JSON.stringify(payload);
    const webhook = await core.app.inject({
      method: "POST",
      url: "/im/fs-main/webhook",
      headers: {
        "content-type": "application/json",
        "x-lark-request-timestamp": "111",
        "x-lark-request-nonce": "nonce",
        "x-lark-signature": feishuSignature("111", "nonce", "ek", raw),
      },
      payload,
    });

    expect(webhook.statusCode).toBe(200);
    expect(webhook.json()).toEqual({ challenge: "challenge-1" });
  });

  it("rejects oversized external webhook payloads before buffering them", async () => {
    core = createCore({ token: "t", dbPath: ":memory:", memoryDbPath: ":memory:" });
    const webhook = await core.app.inject({
      method: "POST",
      url: "/im/fs-main/webhook",
      headers: {
        "content-type": "application/json",
        "content-length": String(32 * 1024 * 1024 + 1),
      },
      payload: {},
    });

    expect(webhook.statusCode).toBe(413);
  });

  it("creates a Feishu connector from the scan registration helper", async () => {
    core = createCore({
      token: "t",
      dbPath: ":memory:",
      memoryDbPath: ":memory:",
      feishuRegister: async (options) => {
        options.onQRCodeReady({ url: "https://accounts.feishu.cn/qr/test", expireIn: 600 });
        return { appId: "cli_scan", appSecret: "scan-secret", tenantBrand: "feishu" };
      },
    });

    const started = await core.app.inject({
      method: "POST",
      url: "/im/feishu/register",
      headers: { ...auth, "content-type": "application/json" },
      payload: {
        id: "fs-scan",
        displayName: "Scan bot",
        enabled: false,
        region: "feishu",
        auth: { allowedUsers: ["ou_1"] },
      },
    });

    expect(started.statusCode).toBe(200);
    const session = started.json().session as { id: string; status: string; qrUrl: string; connectorId: string };
    expect(session).toMatchObject({
      connectorId: "fs-scan",
      qrUrl: "https://accounts.feishu.cn/qr/test",
    });
    expect(["waiting", "completed"]).toContain(session.status);

    let completed: { status: string } | undefined;
    for (let i = 0; i < 10; i++) {
      const polled = await core.app.inject({ method: "GET", url: `/im/feishu/register/${session.id}`, headers: auth });
      expect(polled.statusCode).toBe(200);
      completed = polled.json().session as { status: string };
      if (completed.status === "completed") break;
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(completed).toMatchObject({ status: "completed" });

    const listed = await core.app.inject({ method: "GET", url: "/im/connectors", headers: auth });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      connectors: [
        expect.objectContaining({
          id: "fs-scan",
          kind: "feishu",
          displayName: "Scan bot",
          secrets: { appId: "cli_scan", appSecret: "scan-secret" },
          options: { transport: "websocket", domain: "feishu", receiveIdType: "chat_id" },
          auth: { allowedUsers: ["ou_1"] },
        }),
      ],
    });
  });

  it("does not create a Feishu connector if scan registration is canceled before completion", async () => {
    let resolveRegister!: (value: { appId: string; appSecret: string; tenantBrand: "feishu" }) => void;
    core = createCore({
      token: "t",
      dbPath: ":memory:",
      memoryDbPath: ":memory:",
      feishuRegister: async (options) => {
        options.onQRCodeReady({ url: "https://accounts.feishu.cn/qr/test", expireIn: 600 });
        return await new Promise((resolve) => {
          resolveRegister = resolve;
        });
      },
    });

    const started = await core.app.inject({
      method: "POST",
      url: "/im/feishu/register",
      headers: { ...auth, "content-type": "application/json" },
      payload: {
        id: "fs-canceled",
        displayName: "Canceled bot",
        enabled: false,
        region: "feishu",
      },
    });
    expect(started.statusCode).toBe(200);
    const session = started.json().session as { id: string; status: string };
    expect(session.status).toBe("waiting");

    const canceled = await core.app.inject({ method: "DELETE", url: `/im/feishu/register/${session.id}`, headers: auth });
    expect(canceled.statusCode).toBe(200);

    resolveRegister({ appId: "cli_canceled", appSecret: "canceled-secret", tenantBrand: "feishu" });
    await new Promise((r) => setTimeout(r, 0));

    const polled = await core.app.inject({ method: "GET", url: `/im/feishu/register/${session.id}`, headers: auth });
    expect(polled.statusCode).toBe(200);
    expect(polled.json()).toMatchObject({ session: { status: "aborted" } });

    const listed = await core.app.inject({ method: "GET", url: "/im/connectors", headers: auth });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({ connectors: [] });
  });

  it("aborts pending Feishu scan registration when the core stops", async () => {
    let registerSignal: AbortSignal | undefined;
    core = createCore({
      token: "t",
      dbPath: ":memory:",
      memoryDbPath: ":memory:",
      feishuRegister: async (options) => {
        registerSignal = options.signal;
        options.onQRCodeReady({ url: "https://accounts.feishu.cn/qr/test", expireIn: 600 });
        return await new Promise(() => {});
      },
    });

    const started = await core.app.inject({
      method: "POST",
      url: "/im/feishu/register",
      headers: { ...auth, "content-type": "application/json" },
      payload: {
        id: "fs-stopping",
        enabled: false,
        region: "feishu",
      },
    });
    expect(started.statusCode).toBe(200);
    expect(registerSignal?.aborted).toBe(false);

    await core.stop();
    core = undefined;

    expect(registerSignal?.aborted).toBe(true);
  });

  it("creates a WeChat connector from the iLink QR registration helper", async () => {
    core = createCore({
      token: "t",
      dbPath: ":memory:",
      memoryDbPath: ":memory:",
      wechatRegister: async (options) => {
        options.onQRCodeReady({ url: "https://weixin.example/qr", expireIn: 300, rawCode: "qr-1" });
        options.onStatusChange?.({ status: "scaned" });
        return {
          accountId: "bot-1",
          token: "token-1",
          baseUrl: "https://ilink.example",
          userId: "wxid_me",
        };
      },
    });

    const started = await core.app.inject({
      method: "POST",
      url: "/im/wechat/register",
      headers: { ...auth, "content-type": "application/json" },
      payload: {
        id: "wx-scan",
        displayName: "Personal WeChat",
        enabled: false,
      },
    });

    expect(started.statusCode).toBe(200);
    const session = started.json().session as { id: string; status: string; qrUrl: string; connectorId: string };
    expect(session).toMatchObject({
      connectorId: "wx-scan",
      qrUrl: "https://weixin.example/qr",
    });
    expect(["waiting", "completed"]).toContain(session.status);

    let completed: { status: string } | undefined;
    for (let i = 0; i < 10; i++) {
      const polled = await core.app.inject({ method: "GET", url: `/im/wechat/register/${session.id}`, headers: auth });
      expect(polled.statusCode).toBe(200);
      completed = polled.json().session as { status: string };
      if (completed.status === "completed") break;
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(completed).toMatchObject({ status: "completed" });

    const listed = await core.app.inject({ method: "GET", url: "/im/connectors", headers: auth });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      connectors: [
        expect.objectContaining({
          id: "wx-scan",
          kind: "wechat",
          displayName: "Personal WeChat",
          secrets: { token: "token-1" },
          options: { accountId: "bot-1", baseUrl: "https://ilink.example", userId: "wxid_me", groupPolicy: "disabled" },
          auth: { allowAll: true },
        }),
      ],
    });
  });
});
