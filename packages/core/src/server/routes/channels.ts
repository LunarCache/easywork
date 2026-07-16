import { ChannelConfigSchema, type InboxEvent } from "@ew/shared";
import type { WebhookRequest, WebhookResult } from "@ew/im-connectors";
import { z } from "zod";
import type { CoreHttpContext } from "../context.js";
import { createGuardedStream } from "../guarded-stream.js";
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

export function registerChannelRoutes(ctx: CoreHttpContext): void {
  const { app, channelOps } = ctx;

  app.post("/im/feishu/register", async (req, reply) => {
    const parsed = FeishuSetupSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_feishu_setup", detail: parsed.error.format() });
    }
    return { session: await channelOps.startFeishuSetup(parsed.data) };
  });

  app.get("/im/feishu/register/:id", async (req, reply) => {
    const session = channelOps.getFeishuSetup((req.params as { id: string }).id);
    if (!session) return reply.code(404).send({ error: "unknown_feishu_setup" });
    return { session };
  });

  app.delete("/im/feishu/register/:id", async (req) => {
    channelOps.cancelFeishuSetup((req.params as { id: string }).id);
    return { ok: true };
  });

  app.post("/im/wechat/register", async (req, reply) => {
    const parsed = WechatSetupSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_wechat_setup", detail: parsed.error.format() });
    }
    return { session: await channelOps.startWechatSetup(parsed.data) };
  });

  app.get("/im/wechat/register/:id", async (req, reply) => {
    const session = channelOps.getWechatSetup((req.params as { id: string }).id);
    if (!session) return reply.code(404).send({ error: "unknown_wechat_setup" });
    return { session };
  });

  app.delete("/im/wechat/register/:id", async (req) => {
    channelOps.cancelWechatSetup((req.params as { id: string }).id);
    return { ok: true };
  });

  app.get("/im/adapters", async () => ({ adapters: channelOps.adapters() }));

  app.get("/im/connectors", async () => channelOps.connectors());

  app.post("/im/connectors", async (req, reply) => {
    const parsed = ChannelConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_channel_config", detail: parsed.error.format() });
    }
    try {
      const status = await channelOps.upsertConnector(parsed.data);
      return { ok: true, status };
    } catch (err) {
      return reply.code(400).send({
        error: "channel_config_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post("/im/connectors/:id/start", async (req, reply) => {
    try {
      const status = await channelOps.startConnector((req.params as { id: string }).id);
      return { ok: true, status };
    } catch (err) {
      return reply.code(400).send({
        error: "channel_start_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post("/im/connectors/:id/stop", async (req, reply) => {
    try {
      const status = await channelOps.stopConnector((req.params as { id: string }).id);
      return { ok: true, status };
    } catch (err) {
      return reply.code(400).send({
        error: "channel_stop_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.delete("/im/connectors/:id", async (req) => {
    await channelOps.deleteConnector((req.params as { id: string }).id);
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
      result = await channelOps.handleWebhook((req.params as { id: string }).id, {
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
    let unsubscribe = (): void => {};
    const stream = createGuardedStream(reply, { onCleanup: () => unsubscribe() });
    stream.open({
      ...(req.headers.origin ? { origin: req.headers.origin } : {}),
      heartbeat: { intervalMs: 25_000, chunk: ": keepalive\n\n" },
    });

    const send = (event: InboxEvent) => {
      stream.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    unsubscribe = channelOps.subscribeInbox(send);
    if (stream.signal.aborted) unsubscribe();
  });

  app.get("/inbox/threads", async () => ({ threads: channelOps.listInboxThreads() }));
}
