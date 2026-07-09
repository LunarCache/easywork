import type { ChannelConfig, ChannelStatus, InboxEvent } from "@ew/shared";
import { ChannelConfigSchema, messageText } from "@ew/shared";
import {
  registerFeishuApp,
  registerWechatAccount,
  type WebhookRequest,
  type WebhookResult,
} from "@ew/im-connectors";
import { z } from "zod";
import type { CoreHttpContext } from "../context.js";
import type { RawBodyRequest } from "../http-utils.js";

const FeishuSetupSchema = z.object({
  id: z.string().optional(),
  displayName: z.string().optional(),
  enabled: z.boolean().default(true),
  region: z.enum(["feishu", "lark"]).default("feishu"),
  auth: ChannelConfigSchema.shape.auth.optional(),
});

const WechatSetupSchema = z.object({
  id: z.string().optional(),
  displayName: z.string().optional(),
  enabled: z.boolean().default(true),
  auth: ChannelConfigSchema.shape.auth.optional(),
});

type FeishuSetupStatus = "initializing" | "waiting" | "completed" | "error" | "aborted";

interface FeishuSetupSession {
  id: string;
  connectorId: string;
  displayName?: string;
  status: FeishuSetupStatus;
  createdAt: string;
  qrUrl?: string;
  expireAt?: string;
  statusDetail?: string;
  error?: string;
  channelStatus?: ChannelStatus;
  abort: AbortController;
}

type WechatSetupStatus = "initializing" | "waiting" | "completed" | "error" | "aborted";

interface WechatSetupSession {
  id: string;
  connectorId: string;
  displayName?: string;
  status: WechatSetupStatus;
  createdAt: string;
  qrUrl?: string;
  expireAt?: string;
  statusDetail?: string;
  error?: string;
  channelStatus?: ChannelStatus;
  abort: AbortController;
}

export interface ChannelRouteDeps extends CoreHttpContext {
  feishuRegister: typeof registerFeishuApp;
  wechatRegister: typeof registerWechatAccount;
}

export interface ChannelRouteControls {
  abortSetupSessions(): void;
}

const serializeFeishuSetup = (session: FeishuSetupSession) => ({
  id: session.id,
  connectorId: session.connectorId,
  ...(session.displayName ? { displayName: session.displayName } : {}),
  status: session.status,
  createdAt: session.createdAt,
  ...(session.qrUrl ? { qrUrl: session.qrUrl } : {}),
  ...(session.expireAt ? { expireAt: session.expireAt } : {}),
  ...(session.statusDetail ? { statusDetail: session.statusDetail } : {}),
  ...(session.error ? { error: session.error } : {}),
  ...(session.channelStatus ? { channelStatus: session.channelStatus } : {}),
});

const serializeWechatSetup = (session: WechatSetupSession) => ({
  id: session.id,
  connectorId: session.connectorId,
  ...(session.displayName ? { displayName: session.displayName } : {}),
  status: session.status,
  createdAt: session.createdAt,
  ...(session.qrUrl ? { qrUrl: session.qrUrl } : {}),
  ...(session.expireAt ? { expireAt: session.expireAt } : {}),
  ...(session.statusDetail ? { statusDetail: session.statusDetail } : {}),
  ...(session.error ? { error: session.error } : {}),
  ...(session.channelStatus ? { channelStatus: session.channelStatus } : {}),
});

export function registerChannelRoutes(ctx: ChannelRouteDeps): ChannelRouteControls {
  const { app, channels, repo } = ctx;
  const feishuSetupSessions = new Map<string, FeishuSetupSession>();
  const wechatSetupSessions = new Map<string, WechatSetupSession>();

  const scheduleFeishuSetupCleanup = (id: string): void => {
    setTimeout(() => feishuSetupSessions.delete(id), 10 * 60 * 1000).unref?.();
  };
  const scheduleWechatSetupCleanup = (id: string): void => {
    setTimeout(() => wechatSetupSessions.delete(id), 10 * 60 * 1000).unref?.();
  };

  app.post("/im/feishu/register", async (req, reply) => {
    const parsed = FeishuSetupSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_feishu_setup", detail: parsed.error.format() });
    }

    const sessionId = crypto.randomUUID();
    const connectorId = parsed.data.id?.trim() || `feishu-${sessionId.slice(0, 8)}`;
    const abort = new AbortController();
    const session: FeishuSetupSession = {
      id: sessionId,
      connectorId,
      ...(parsed.data.displayName ? { displayName: parsed.data.displayName } : {}),
      status: "initializing",
      createdAt: new Date().toISOString(),
      abort,
    };
    feishuSetupSessions.set(sessionId, session);

    let resolveQr: (() => void) | undefined;
    let rejectQr: ((err: Error) => void) | undefined;
    const qrReady = new Promise<void>((resolve, reject) => {
      resolveQr = resolve;
      rejectQr = reject;
    });

    void ctx.feishuRegister({
      region: parsed.data.region,
      signal: abort.signal,
      onQRCodeReady: (info) => {
        session.status = "waiting";
        session.qrUrl = info.url;
        session.expireAt = new Date(Date.now() + info.expireIn * 1000).toISOString();
        resolveQr?.();
      },
      onStatusChange: (info) => {
        session.statusDetail = info.status;
      },
    }).then(async (result) => {
      if (abort.signal.aborted || session.status === "aborted") {
        session.status = "aborted";
        scheduleFeishuSetupCleanup(sessionId);
        return;
      }
      const config: ChannelConfig = {
        id: connectorId,
        kind: "feishu",
        enabled: parsed.data.enabled,
        ...(parsed.data.displayName ? { displayName: parsed.data.displayName } : {}),
        secrets: { appId: result.appId, appSecret: result.appSecret },
        options: {
          transport: "websocket",
          domain: result.tenantBrand ?? parsed.data.region,
          receiveIdType: "chat_id",
        },
        auth: parsed.data.auth ?? { allowAll: true },
      };
      let status = await channels.upsert(config);
      ctx.persistChannels();
      if (config.enabled) status = await channels.start(config.id);
      ctx.emitInboxChanged({ reason: "connector" });
      session.status = "completed";
      session.channelStatus = status;
      scheduleFeishuSetupCleanup(sessionId);
    }).catch((err) => {
      session.status = abort.signal.aborted ? "aborted" : "error";
      session.error = err instanceof Error ? err.message : String(err);
      rejectQr?.(err instanceof Error ? err : new Error(String(err)));
      scheduleFeishuSetupCleanup(sessionId);
    });

    await Promise.race([
      qrReady.catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 10_000)),
    ]);
    return { session: serializeFeishuSetup(session) };
  });

  app.get("/im/feishu/register/:id", async (req, reply) => {
    const session = feishuSetupSessions.get((req.params as { id: string }).id);
    if (!session) return reply.code(404).send({ error: "unknown_feishu_setup" });
    return { session: serializeFeishuSetup(session) };
  });

  app.delete("/im/feishu/register/:id", async (req) => {
    const session = feishuSetupSessions.get((req.params as { id: string }).id);
    if (session && (session.status === "initializing" || session.status === "waiting")) {
      session.abort.abort();
      session.status = "aborted";
      scheduleFeishuSetupCleanup(session.id);
    }
    return { ok: true };
  });

  app.post("/im/wechat/register", async (req, reply) => {
    const parsed = WechatSetupSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_wechat_setup", detail: parsed.error.format() });
    }

    const sessionId = crypto.randomUUID();
    const connectorId = parsed.data.id?.trim() || `wechat-${sessionId.slice(0, 8)}`;
    const abort = new AbortController();
    const session: WechatSetupSession = {
      id: sessionId,
      connectorId,
      ...(parsed.data.displayName ? { displayName: parsed.data.displayName } : {}),
      status: "initializing",
      createdAt: new Date().toISOString(),
      abort,
    };
    wechatSetupSessions.set(sessionId, session);

    let resolveQr: (() => void) | undefined;
    let rejectQr: ((err: Error) => void) | undefined;
    const qrReady = new Promise<void>((resolve, reject) => {
      resolveQr = resolve;
      rejectQr = reject;
    });

    void ctx.wechatRegister({
      signal: abort.signal,
      onQRCodeReady: (info) => {
        session.status = "waiting";
        session.qrUrl = info.url;
        session.expireAt = new Date(Date.now() + info.expireIn * 1000).toISOString();
        resolveQr?.();
      },
      onStatusChange: (info) => {
        session.statusDetail = info.status;
      },
    }).then(async (result) => {
      if (abort.signal.aborted || session.status === "aborted") {
        session.status = "aborted";
        scheduleWechatSetupCleanup(sessionId);
        return;
      }
      const config: ChannelConfig = {
        id: connectorId,
        kind: "wechat",
        enabled: parsed.data.enabled,
        ...(parsed.data.displayName ? { displayName: parsed.data.displayName } : {}),
        secrets: { token: result.token },
        options: {
          accountId: result.accountId,
          baseUrl: result.baseUrl,
          ...(result.userId ? { userId: result.userId } : {}),
          groupPolicy: "disabled",
        },
        auth: parsed.data.auth ?? { allowAll: true },
      };
      let status = await channels.upsert(config);
      ctx.persistChannels();
      if (config.enabled) status = await channels.start(config.id);
      ctx.emitInboxChanged({ reason: "connector" });
      session.status = "completed";
      session.channelStatus = status;
      scheduleWechatSetupCleanup(sessionId);
    }).catch((err) => {
      session.status = abort.signal.aborted ? "aborted" : "error";
      session.error = err instanceof Error ? err.message : String(err);
      rejectQr?.(err instanceof Error ? err : new Error(String(err)));
      scheduleWechatSetupCleanup(sessionId);
    });

    await Promise.race([
      qrReady.catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 10_000)),
    ]);
    return { session: serializeWechatSetup(session) };
  });

  app.get("/im/wechat/register/:id", async (req, reply) => {
    const session = wechatSetupSessions.get((req.params as { id: string }).id);
    if (!session) return reply.code(404).send({ error: "unknown_wechat_setup" });
    return { session: serializeWechatSetup(session) };
  });

  app.delete("/im/wechat/register/:id", async (req) => {
    const session = wechatSetupSessions.get((req.params as { id: string }).id);
    if (session && (session.status === "initializing" || session.status === "waiting")) {
      session.abort.abort();
      session.status = "aborted";
      scheduleWechatSetupCleanup(session.id);
    }
    return { ok: true };
  });

  app.get("/im/adapters", async () => ({ adapters: channels.metas() }));

  app.get("/im/connectors", async () => ({
    connectors: channels.configs(),
    status: channels.statuses(),
  }));

  app.post("/im/connectors", async (req, reply) => {
    const parsed = ChannelConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_channel_config", detail: parsed.error.format() });
    }
    try {
      let status = await channels.upsert(parsed.data);
      ctx.persistChannels();
      if (parsed.data.enabled) status = await channels.start(parsed.data.id);
      ctx.emitInboxChanged({ reason: "connector" });
      return { ok: true, status };
    } catch (err) {
      return reply.code(400).send({ error: "channel_config_failed", message: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/im/connectors/:id/start", async (req, reply) => {
    try {
      const status = await channels.start((req.params as { id: string }).id);
      ctx.emitInboxChanged({ reason: "status" });
      return { ok: true, status };
    } catch (err) {
      return reply.code(400).send({ error: "channel_start_failed", message: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/im/connectors/:id/stop", async (req, reply) => {
    try {
      const status = await channels.stop((req.params as { id: string }).id);
      ctx.emitInboxChanged({ reason: "status" });
      return { ok: true, status };
    } catch (err) {
      return reply.code(400).send({ error: "channel_stop_failed", message: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete("/im/connectors/:id", async (req) => {
    await channels.remove((req.params as { id: string }).id);
    ctx.persistChannels();
    ctx.emitInboxChanged({ reason: "connector" });
    return { ok: true };
  });

  app.all("/im/:id/webhook", async (req, reply) => {
    const headers: WebhookRequest["headers"] = {};
    for (const [key, value] of Object.entries(req.headers)) headers[key] = value;
    const query: WebhookRequest["query"] = {};
    for (const [key, value] of Object.entries(req.query as Record<string, string | string[] | undefined>)) {
      query[key] = value;
    }
    let result: WebhookResult;
    try {
      result = await channels.handleWebhook((req.params as { id: string }).id, {
        method: req.method,
        path: req.url,
        query,
        headers,
        body: req.body,
        rawBody: (req as RawBodyRequest).rawBody,
      });
    } catch (err) {
      return reply.code(404).send({
        error: "unknown_channel_connector",
        message: err instanceof Error ? err.message : String(err),
      });
    }
    if (result.headers) {
      for (const [key, value] of Object.entries(result.headers)) reply.header(key, value);
    }
    return reply.code(result.status ?? 200).send(result.body ?? { ok: true });
  });

  app.get("/inbox/events", async (req, reply) => {
    reply.hijack();
    const raw = reply.raw;
    raw.on("error", () => {});
    raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": req.headers.origin ?? "*",
    });

    const send = (event: InboxEvent) => {
      if (!raw.writableEnded && !raw.destroyed) raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const heartbeat = setInterval(() => {
      if (!raw.writableEnded && !raw.destroyed) raw.write(": keepalive\n\n");
    }, 25_000);
    heartbeat.unref?.();
    const cleanup = () => {
      clearInterval(heartbeat);
      ctx.inboxSubscribers.delete(send);
    };
    raw.on("close", cleanup);
    ctx.inboxSubscribers.add(send);
    send({ type: "ready", at: new Date().toISOString() });
  });

  app.get("/inbox/threads", async () => {
    const threads = repo
      .listThreads()
      .filter((thread) => thread.channel)
      .map((thread) => {
        const history = repo.history(thread.id);
        const last = [...history].reverse().find((message) => messageText(message.parts).trim());
        return {
          id: thread.id,
          title: thread.title,
          channel: thread.channel!,
          ...(thread.projectId ? { projectId: thread.projectId } : {}),
          modelId: thread.modelId,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
          messageCount: history.length,
          ...(last
            ? {
                lastMessage: {
                  role: last.role,
                  text: messageText(last.parts).trim(),
                  createdAt: last.createdAt,
                },
              }
            : {}),
        };
      });
    return { threads };
  });

  return {
    abortSetupSessions() {
      for (const session of feishuSetupSessions.values()) {
        if (session.status === "initializing" || session.status === "waiting") {
          session.abort.abort();
          session.status = "aborted";
        }
      }
      for (const session of wechatSetupSessions.values()) {
        if (session.status === "initializing" || session.status === "waiting") {
          session.abort.abort();
          session.status = "aborted";
        }
      }
    },
  };
}
