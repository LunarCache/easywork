import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCore, type CoreServer } from "../src/server/app.js";

const auth = { authorization: "Bearer t" };

function tempDb(): { dir: string; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ew-im-"));
  return { dir, dbPath: path.join(dir, "conv.db") };
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
});
