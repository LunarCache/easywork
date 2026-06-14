import { z } from "zod";

/** MCP 传输配置：stdio（本地命令）或 streamable HTTP。 */
export const McpTransportSchema = z.union([
  z.object({
    kind: z.literal("stdio"),
    command: z.string(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).optional(),
  }),
  z.object({
    kind: z.literal("http"),
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).optional(),
    useOAuth: z.boolean().optional(),
  }),
]);
export type McpTransport = z.infer<typeof McpTransportSchema>;

export const McpServerConfigSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  transport: McpTransportSchema,
  enabled: z.boolean().default(true),
});
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

export const McpProbeResultSchema = z.object({
  ok: z.boolean(),
  toolCount: z.number().int().nonnegative(),
  error: z.string().optional(),
});
export type McpProbeResult = z.infer<typeof McpProbeResultSchema>;

/** 失败 cooloff 常量（移植自参考 mcp_client.py）。 */
export const MCP_FAILED_PROBE_COOLOFF_MS = 60_000;
export const MCP_OAUTH_PROBE_COOLOFF_MS = 300_000;

/** MCP 工具命名空间前缀：mcp__<serverId>__<toolName>。注意自愈解析器 name 字符类须含 `-`。 */
export function mcpToolName(serverId: string, toolName: string): string {
  return `mcp__${serverId}__${toolName}`;
}

export function parseMcpToolName(
  name: string,
): { serverId: string; toolName: string } | null {
  const m = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name);
  if (!m) return null;
  return { serverId: m[1]!, toolName: m[2]! };
}
