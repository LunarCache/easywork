import { describe, expect, it } from "vitest";
import { EasyWorkClient, type InboxEvent } from "./index.js";

function makeClient() {
  const calls: { url: string; init?: RequestInit }[] = [];
  let hfMirrorEnabled = false;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/settings/huggingface")) {
      if (init?.method === "POST") {
        hfMirrorEnabled = Boolean(JSON.parse(String(init.body ?? "{}") || "{}").useMirror);
      }
      return new Response(JSON.stringify({
        ...(init?.method === "POST" ? { ok: true } : {}),
        useMirror: hfMirrorEnabled,
        endpoint: hfMirrorEnabled ? "https://hf-mirror.com" : "https://huggingface.co",
      }), { status: 200 });
    }
    if (String(url).endsWith("/im/adapters")) {
      return new Response(JSON.stringify({ adapters: [{ kind: "telegram", label: "Telegram", requiredSecrets: [] }] }), { status: 200 });
    }
    if (String(url).endsWith("/im/connectors") && (!init || init.method !== "POST")) {
      return new Response(JSON.stringify({ connectors: [], status: [] }), { status: 200 });
    }
    if (String(url).endsWith("/inbox/threads")) {
      return new Response(
        JSON.stringify({
          threads: [
            {
              id: "thread-wx",
              title: "wechat:wxid_alice",
              channel: { kind: "wechat", channelId: "wxid_alice" },
              modelId: "m",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:01:00.000Z",
              messageCount: 1,
              lastMessage: { role: "user", text: "hello", createdAt: "2026-01-01T00:01:00.000Z" },
            },
          ],
        }),
        { status: 200 },
      );
    }
    if (String(url).endsWith("/inbox/events")) {
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"type":"ready","at":"2026-01-01T00:00:00.000Z"}\n\n'));
            controller.enqueue(
              encoder.encode(
                'data: {"type":"changed","reason":"message","at":"2026-01-01T00:00:01.000Z","threadId":"thread-wx","channel":{"kind":"wechat","channelId":"wxid_alice"}}\n\n',
              ),
            );
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }
    if (String(url).endsWith("/memory/legacy-skills")) {
      return new Response(
        JSON.stringify({
          items: [
            {
              id: "legacy-1",
              text: "Deploy with the release checklist",
              updatedAt: "2026-01-01T00:00:00.000Z",
              disposition: "ambiguous",
            },
          ],
        }),
        { status: 200 },
      );
    }
    if (String(url).endsWith("/memory/provider")) {
      const enabled = init?.method === "PATCH"
        ? Boolean(JSON.parse(String(init.body ?? "{}") || "{}").enabled)
        : true;
      return new Response(JSON.stringify({ configured: true, enabled, id: "deep-memory" }), { status: 200 });
    }
    if (String(url).includes("/start") || String(url).includes("/stop") || (String(url).endsWith("/im/connectors") && init?.method === "POST")) {
      return new Response(JSON.stringify({ ok: true, status: { id: "tg", kind: "telegram", enabled: true, running: true } }), { status: 200 });
    }
    if (String(url).includes("/im/connectors/") && init?.method === "DELETE") {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (String(url).endsWith("/im/feishu/register") && init?.method === "POST") {
      return new Response(JSON.stringify({ session: { id: "scan-1", connectorId: "fs", status: "waiting", createdAt: "now", qrUrl: "https://qr" } }), { status: 200 });
    }
    if (String(url).includes("/im/feishu/register/") && init?.method === "DELETE") {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (String(url).includes("/im/feishu/register/")) {
      return new Response(JSON.stringify({ session: { id: "scan-1", connectorId: "fs", status: "completed", createdAt: "now" } }), { status: 200 });
    }
    if (String(url).endsWith("/im/wechat/register") && init?.method === "POST") {
      return new Response(JSON.stringify({ session: { id: "wx-scan-1", connectorId: "wx", status: "waiting", createdAt: "now", qrUrl: "https://wx-qr" } }), { status: 200 });
    }
    if (String(url).includes("/im/wechat/register/") && init?.method === "DELETE") {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (String(url).includes("/im/wechat/register/")) {
      return new Response(JSON.stringify({ session: { id: "wx-scan-1", connectorId: "wx", status: "completed", createdAt: "now" } }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return { client: new EasyWorkClient({ baseUrl: "http://127.0.0.1:1", token: "t", fetch: fetchImpl }), calls };
}

describe("EasyWorkClient IM routes", () => {
  it("calls channel management routes", async () => {
    const { client, calls } = makeClient();
    const adapters = await client.listChannelAdapters();
    expect(adapters[0]).toMatchObject({ kind: "telegram", label: "Telegram" });

    await client.listChannelConnectors();
    await client.listChannelStatuses();
    await client.upsertChannelConnector({
      id: "tg",
      kind: "telegram",
      enabled: true,
      displayName: "TG",
      secrets: { token: "x" },
      options: {},
      auth: { allowAll: true },
    });
    await client.startChannelConnector("tg");
    await client.stopChannelConnector("tg");
    await client.removeChannelConnector("tg");
    await client.startFeishuRegistration({ id: "fs" });
    await client.getFeishuRegistration("scan-1");
    await client.cancelFeishuRegistration("scan-1");
    await client.startWechatRegistration({ id: "wx" });
    await client.getWechatRegistration("wx-scan-1");
    await client.cancelWechatRegistration("wx-scan-1");
    const inbox = await client.listInboxThreads();
    const events: InboxEvent[] = [];
    for await (const event of client.inboxEvents()) events.push(event);

    expect(calls.some((c) => String(c.url).endsWith("/im/adapters"))).toBe(true);
    expect(calls.some((c) => String(c.url).endsWith("/im/connectors"))).toBe(true);
    expect(calls.some((c) => String(c.url).includes("/im/connectors/tg/start"))).toBe(true);
    expect(calls.some((c) => String(c.url).includes("/im/connectors/tg/stop"))).toBe(true);
    expect(calls.some((c) => String(c.url).includes("/im/connectors/tg") && c.init?.method === "DELETE")).toBe(true);
    expect(calls.some((c) => String(c.url).endsWith("/im/feishu/register") && c.init?.method === "POST")).toBe(true);
    expect(calls.some((c) => String(c.url).includes("/im/feishu/register/scan-1") && c.init?.method === "DELETE")).toBe(true);
    expect(calls.some((c) => String(c.url).endsWith("/im/wechat/register") && c.init?.method === "POST")).toBe(true);
    expect(calls.some((c) => String(c.url).includes("/im/wechat/register/wx-scan-1") && c.init?.method === "DELETE")).toBe(true);
    expect(calls.some((c) => String(c.url).endsWith("/inbox/threads"))).toBe(true);
    expect(calls.some((c) => String(c.url).endsWith("/inbox/events") && !c.init?.method)).toBe(true);
    expect(inbox[0]).toMatchObject({ id: "thread-wx", channel: { kind: "wechat" }, lastMessage: { text: "hello" } });
    expect(events).toEqual([
      { type: "ready", at: "2026-01-01T00:00:00.000Z" },
      {
        type: "changed",
        reason: "message",
        at: "2026-01-01T00:00:01.000Z",
        threadId: "thread-wx",
        channel: { kind: "wechat", channelId: "wxid_alice" },
      },
    ]);
  });
});

describe("EasyWorkClient Hugging Face settings", () => {
  it("reads and updates the HF mirror setting", async () => {
    const { client, calls } = makeClient();

    await expect(client.getHuggingFaceSettings()).resolves.toEqual({
      useMirror: false,
      endpoint: "https://huggingface.co",
    });
    await expect(client.setHuggingFaceMirror(true)).resolves.toEqual({
      ok: true,
      useMirror: true,
      endpoint: "https://hf-mirror.com",
    });
    expect(calls.filter((call) => call.url.endsWith("/settings/huggingface"))).toHaveLength(2);
  });
});

describe("EasyWorkClient memory migration routes", () => {
  it("lists the read-only legacy Skill migration pool", async () => {
    const { client, calls } = makeClient();

    await expect(client.listLegacySkillMemory()).resolves.toEqual([
      expect.objectContaining({ id: "legacy-1", disposition: "ambiguous" }),
    ]);
    expect(calls.some((call) => String(call.url).endsWith("/memory/legacy-skills"))).toBe(true);
  });

  it("reads and toggles the additive memory provider", async () => {
    const { client, calls } = makeClient();

    await expect(client.memoryProviderStatus()).resolves.toEqual({ configured: true, enabled: true, id: "deep-memory" });
    await expect(client.setMemoryProviderEnabled(false)).resolves.toEqual({ configured: true, enabled: false, id: "deep-memory" });
    expect(calls.some((call) => String(call.url).endsWith("/memory/provider") && call.init?.method === "PATCH")).toBe(true);
  });
});
