import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCore, type CoreServer } from "../src/server/app.js";

const auth = { authorization: "Bearer t" };

function tempDb(): { dir: string; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ew-im-"));
  return { dir, dbPath: path.join(dir, "conv.db") };
}

function feishuSignature(timestamp: string, nonce: string, encryptKey: string, body: string): string {
  return createHash("sha256").update(timestamp + nonce + encryptKey).update(body).digest("hex");
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
    core = createCore({ token: "t", dbPath: ":memory:", memoryDbPath: ":memory:", kbDbPath: ":memory:" });
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
      ]),
    );
  });

  it("persists connector configs and restores them on the next core instance", async () => {
    const { dir, dbPath } = tempDb();
    cleanup.push(dir);

    core = createCore({ token: "t", dbPath, memoryDbPath: ":memory:", kbDbPath: ":memory:" });
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
          secrets: { token: "test-token" },
          options: { pollTimeout: 1 },
          auth: { allowedUsers: ["42"] },
        },
      ],
      status: [expect.objectContaining({ id: "tg-main", running: false })],
    });

    await core.stop();
    core = createCore({ token: "t", dbPath, memoryDbPath: ":memory:", kbDbPath: ":memory:" });
    const restored = await core.app.inject({ method: "GET", url: "/im/connectors", headers: auth });

    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({
      connectors: [expect.objectContaining({ id: "tg-main", kind: "telegram", displayName: "Main bot" })],
      status: [expect.objectContaining({ id: "tg-main", running: false })],
    });
  });

  it("requires bearer auth and returns adapter webhook result", async () => {
    core = createCore({ token: "t", dbPath: ":memory:", memoryDbPath: ":memory:", kbDbPath: ":memory:" });
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
    core = createCore({ token: "t", dbPath: ":memory:", memoryDbPath: ":memory:", kbDbPath: ":memory:" });
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
    core = createCore({ token: "t", dbPath: ":memory:", memoryDbPath: ":memory:", kbDbPath: ":memory:" });
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
      kbDbPath: ":memory:",
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
      kbDbPath: ":memory:",
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
});
