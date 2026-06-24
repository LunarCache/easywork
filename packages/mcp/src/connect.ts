import type { McpServerConfig } from "@ew/shared";

export interface McpToolSpec {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export type McpContentPart = { type: "text"; text: string } | { type: string; [k: string]: unknown };

export interface McpConnection {
  listTools(): Promise<McpToolSpec[]>;
  callTool(name: string, args: unknown, signal?: AbortSignal): Promise<{ content: McpContentPart[]; isError?: boolean }>;
  close(): Promise<void>;
}

export type ConnectFn = (cfg: McpServerConfig) => Promise<McpConnection>;

/**
 * 真实连接：动态导入 @modelcontextprotocol/sdk（stdio + streamable HTTP）。
 * 动态导入使本包在无 SDK / 测试环境下仍可加载（用注入的 connect）。
 */
export const realConnect: ConnectFn = async (cfg) => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  let transport: unknown;
  if (cfg.transport.kind === "stdio") {
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    transport = new StdioClientTransport({
      command: cfg.transport.command,
      args: cfg.transport.args,
      ...(cfg.transport.env ? { env: cfg.transport.env } : {}),
    });
  } else {
    const { StreamableHTTPClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/streamableHttp.js"
    );
    transport = new StreamableHTTPClientTransport(new URL(cfg.transport.url), {
      requestInit: cfg.transport.headers ? { headers: cfg.transport.headers } : undefined,
    });
  }

  const client = new Client({ name: "easywork", version: "0.0.0" }, { capabilities: {} });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await client.connect(transport as any);

  return {
    async listTools() {
      const res = await client.listTools();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (res.tools ?? []).map((t: any) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
    },
    async callTool(name, args, signal) {
      const res = await client.callTool({ name, arguments: (args ?? {}) as Record<string, unknown> }, undefined, signal ? { signal } : undefined);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { content: (res.content ?? []) as McpContentPart[], isError: (res as any).isError };
    },
    async close() {
      await client.close();
    },
  };
};
