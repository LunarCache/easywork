import { McpServerConfigSchema } from "@ew/shared";
import type { CoreHttpContext } from "../context.js";

export function registerMcpRoutes(ctx: CoreHttpContext): void {
  const { app, mcp, sessionHost, persistMcp } = ctx;

  app.get("/mcp/servers", async () => ({ servers: mcp.list() }));
  app.post("/mcp/servers", async (req, reply) => {
    const parsed = McpServerConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_config", detail: parsed.error.format() });
    }
    await mcp.upsert(parsed.data);
    persistMcp();
    sessionHost.invalidateAll(); // MCP 工具集变更 → 重建会话以刷新 customTools。
    return { ok: true };
  });
  app.delete("/mcp/servers/:id", async (req) => {
    await mcp.remove((req.params as { id: string }).id);
    persistMcp();
    sessionHost.invalidateAll();
    return { ok: true };
  });
  app.post("/mcp/probe", async (req, reply) => {
    const parsed = McpServerConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_config", detail: parsed.error.format() });
    }
    return mcp.probe(parsed.data);
  });
  app.get("/mcp/servers/:id/tools", async (req) => {
    const tools = await mcp.listToolsOf((req.params as { id: string }).id);
    return { tools };
  });
}
