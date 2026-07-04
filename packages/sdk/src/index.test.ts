import { describe, expect, it } from "vitest";
import { EasyWorkClient } from "./index.js";

function makeClient() {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/im/adapters")) {
      return new Response(JSON.stringify({ adapters: [{ kind: "telegram", label: "Telegram", requiredSecrets: [] }] }), { status: 200 });
    }
    if (String(url).endsWith("/im/connectors") && (!init || init.method !== "POST")) {
      return new Response(JSON.stringify({ connectors: [], status: [] }), { status: 200 });
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

    expect(calls.some((c) => String(c.url).endsWith("/im/adapters"))).toBe(true);
    expect(calls.some((c) => String(c.url).endsWith("/im/connectors"))).toBe(true);
    expect(calls.some((c) => String(c.url).includes("/im/connectors/tg/start"))).toBe(true);
    expect(calls.some((c) => String(c.url).includes("/im/connectors/tg/stop"))).toBe(true);
    expect(calls.some((c) => String(c.url).includes("/im/connectors/tg") && c.init?.method === "DELETE")).toBe(true);
    expect(calls.some((c) => String(c.url).endsWith("/im/feishu/register") && c.init?.method === "POST")).toBe(true);
    expect(calls.some((c) => String(c.url).includes("/im/feishu/register/scan-1") && c.init?.method === "DELETE")).toBe(true);
  });
});
