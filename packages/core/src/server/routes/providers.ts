import type { CoreHttpContext } from "../context.js";
import { ProviderCatalog, ProviderConfigSchema, ProviderModelProbeSchema } from "../../providers/catalog.js";

export function registerProviderRoutes(ctx: CoreHttpContext): void {
  const { app, providers, sessionHost } = ctx;
  const catalog = new ProviderCatalog({ fetchImpl: ctx.fetchImpl });

  app.get("/providers", async () => ({ providers: providers.list() }));

  app.get("/providers/catalog", async () => catalog.info());

  app.post("/providers/probe-models", async (req, reply) => {
    const parsed = ProviderModelProbeSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_provider_probe", detail: parsed.error.format() });
    }
    try {
      const result = await catalog.probeCompatibleModels(parsed.data);
      return result;
    } catch (e) {
      return reply.code(502).send({
        error: "provider_probe_failed",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  });

  app.post("/providers", async (req, reply) => {
    const parsed = ProviderConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_provider", detail: parsed.error.format() });
    }
    providers.add(parsed.data);
    ctx.persistProviders();
    sessionHost.syncCloudProviders();
    return { ok: true };
  });

  app.delete("/providers/:id", async (req) => {
    providers.remove((req.params as { id: string }).id);
    ctx.persistProviders();
    sessionHost.syncCloudProviders();
    return { ok: true };
  });
}
