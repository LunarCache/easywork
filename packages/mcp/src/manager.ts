import {
  MCP_FAILED_PROBE_COOLOFF_MS,
  MCP_OAUTH_PROBE_COOLOFF_MS,
  mcpToolName,
  type McpProbeResult,
  type McpServerConfig,
  type McpToolInfo,
  type Tool,
  type ToolProvider,
  type ToolResult,
} from "@ew/shared";
import { realConnect, type ConnectFn, type McpConnection, type McpContentPart, type McpToolSpec } from "./connect.js";

/** 探测超时（防假死 server 挂住请求）。 */
const PROBE_TIMEOUT_MS = 15_000;

/** 给 promise 套超时；无论成功/失败/超时都清掉定时器（避免每次成功探测泄漏一个挂到 15s 的 timer）。 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`探测超时（${ms / 1000}s）`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** McpToolSpec → McpToolInfo（只取 name + description，供 UI 预览）。 */
function toToolInfo(t: McpToolSpec): McpToolInfo {
  return { name: t.name, ...(t.description ? { description: t.description } : {}) };
}

interface ServerState {
  config: McpServerConfig;
  conn?: McpConnection;
  toolsCache?: McpToolSpec[];
  failedUntil?: number;
}

export interface McpClientManagerDeps {
  connect?: ConnectFn;
  now?: () => number;
  /** stdio MCP 是否允许（默认读 env EW_ALLOW_STDIO_MCP==="1"）。stdio 会在本机执行任意命令，默认禁用。 */
  allowStdio?: boolean;
}

/** 轻量 JSON Schema 校验：检查 args 为对象且 required 字段齐全、顶层类型大致匹配。 */
function validateAgainstSchema(
  schema: { type?: string; properties?: Record<string, { type?: string }>; required?: string[] } | undefined,
  args: unknown,
): string | null {
  if (!schema || schema.type !== "object") return null;
  if (args == null || typeof args !== "object" || Array.isArray(args)) return "参数必须是 JSON 对象";
  const obj = args as Record<string, unknown>;
  for (const key of schema.required ?? []) {
    if (!(key in obj) || obj[key] == null) return `缺少必填参数：${key}`;
  }
  for (const [key, spec] of Object.entries(schema.properties ?? {})) {
    if (!(key in obj) || obj[key] == null || !spec.type) continue;
    const v = obj[key];
    const actual = Array.isArray(v) ? "array" : typeof v;
    const want = spec.type;
    const ok =
      (want === "integer" && actual === "number") ||
      (want === "number" && actual === "number") ||
      (want === "string" && actual === "string") ||
      (want === "boolean" && actual === "boolean") ||
      (want === "object" && actual === "object") ||
      (want === "array" && actual === "array");
    if (!ok) return `参数 ${key} 类型应为 ${want}，实际 ${actual}`;
  }
  return null;
}

/** 把 MCP 工具内容拍平成模型可读字符串。 */
function flattenContent(parts: McpContentPart[]): string {
  const out: string[] = [];
  for (const p of parts) {
    if (p.type === "text" && typeof (p as { text?: string }).text === "string") {
      out.push((p as { text: string }).text);
    } else {
      out.push(`[${p.type} content]`);
    }
  }
  return out.join("\n");
}

/**
 * MCP 客户端管理：stdio + HTTP；工具命名空间 mcp__<serverId>__<tool>；
 * 失败 cooloff（普通 60s / OAuth 300s）+ 工具列表缓存 —— flaky server 不破坏注册表。
 */
export class McpClientManager {
  private readonly servers = new Map<string, ServerState>();
  private readonly connect: ConnectFn;
  private readonly now: () => number;
  private readonly allowStdio: boolean;

  constructor(deps: McpClientManagerDeps = {}) {
    this.connect = deps.connect ?? realConnect;
    this.now = deps.now ?? (() => Date.now());
    this.allowStdio = deps.allowStdio ?? process.env.EW_ALLOW_STDIO_MCP === "1";
  }

  /** stdio 默认禁用（本机任意命令执行风险）；返回禁用原因或 null。 */
  private stdioBlocked(cfg: McpServerConfig): string | null {
    if (cfg.transport.kind === "stdio" && !this.allowStdio) {
      return "stdio MCP 默认禁用（设置环境变量 EW_ALLOW_STDIO_MCP=1 后启用）";
    }
    return null;
  }

  async upsert(cfg: McpServerConfig): Promise<void> {
    const existing = this.servers.get(cfg.id);
    if (existing?.conn) await existing.conn.close().catch(() => {});
    this.servers.set(cfg.id, { config: cfg });
  }

  async remove(id: string): Promise<void> {
    const s = this.servers.get(id);
    if (s?.conn) await s.conn.close().catch(() => {});
    this.servers.delete(id);
  }

  list(): McpServerConfig[] {
    return [...this.servers.values()].map((s) => s.config);
  }

  private inCooloff(s: ServerState): boolean {
    return s.failedUntil != null && this.now() < s.failedUntil;
  }

  private cooloffMs(cfg: McpServerConfig): number {
    return cfg.transport.kind === "http" && cfg.transport.useOAuth
      ? MCP_OAUTH_PROBE_COOLOFF_MS
      : MCP_FAILED_PROBE_COOLOFF_MS;
  }

  private recordFailure(s: ServerState): void {
    s.failedUntil = this.now() + this.cooloffMs(s.config);
    s.conn = undefined;
  }

  private async ensureConn(s: ServerState): Promise<McpConnection> {
    if (s.conn) return s.conn;
    s.conn = await this.connect(s.config);
    return s.conn;
  }

  async probe(cfg: McpServerConfig): Promise<McpProbeResult> {
    const blocked = this.stdioBlocked(cfg);
    if (blocked) return { ok: false, toolCount: 0, tools: [], error: blocked };
    try {
      const conn = await this.connect(cfg);
      let tools: McpToolSpec[];
      try {
        tools = await withTimeout(conn.listTools(), PROBE_TIMEOUT_MS);
      } finally {
        await conn.close().catch(() => {});
      }
      return { ok: true, toolCount: tools.length, tools: tools.map(toToolInfo) };
    } catch (e) {
      return { ok: false, toolCount: 0, tools: [], error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 列出某服务器工具（用于 UI 预览，总是真连、不走 cooloff 门控）。 */
  async listToolsOf(id: string): Promise<McpToolInfo[]> {
    const s = this.servers.get(id);
    if (!s) return [];
    const blocked = this.stdioBlocked(s.config);
    if (blocked) return [];
    try {
      const conn = await this.connect(s.config);
      let tools: McpToolSpec[];
      try {
        tools = await withTimeout(conn.listTools(), PROBE_TIMEOUT_MS);
      } finally {
        await conn.close().catch(() => {});
      }
      return tools.map(toToolInfo);
    } catch {
      return s.toolsCache?.map(toToolInfo) ?? [];
    }
  }

  /** 列出某服务器工具（缓存 + cooloff 门控）。 */
  async listTools(id: string): Promise<McpToolSpec[]> {
    const s = this.servers.get(id);
    if (!s || !s.config.enabled) return [];
    if (this.stdioBlocked(s.config)) return [];
    if (this.inCooloff(s)) return s.toolsCache ?? [];
    try {
      const conn = await this.ensureConn(s);
      const tools = await conn.listTools();
      s.toolsCache = tools;
      s.failedUntil = undefined;
      return tools;
    } catch {
      this.recordFailure(s);
      return s.toolsCache ?? [];
    }
  }

  async callTool(id: string, name: string, args: unknown, signal?: AbortSignal): Promise<ToolResult> {
    const s = this.servers.get(id);
    if (!s) return { content: `未知 MCP 服务器: ${id}`, isError: true };
    const blocked = this.stdioBlocked(s.config);
    if (blocked) return { content: blocked, isError: true };
    // 调用前用工具 inputSchema 做轻量校验，避免把明显非法参数发给 server。
    const spec = s.toolsCache?.find((t) => t.name === name);
    const invalid = validateAgainstSchema(spec?.inputSchema as never, args);
    if (invalid) return { content: `参数校验失败：${invalid}`, isError: true };
    try {
      const conn = await this.ensureConn(s);
      const res = await conn.callTool(name, args, signal);
      return { content: flattenContent(res.content), isError: res.isError };
    } catch (e) {
      this.recordFailure(s);
      return { content: `MCP 调用失败: ${e instanceof Error ? e.message : String(e)}`, isError: true };
    }
  }

  /** 作为 ToolProvider 暴露所有启用服务器的工具（mcp__ 命名空间）。 */
  toolProvider(): ToolProvider {
    return {
      tools: async (ctx) => {
        const result: Tool[] = [];
        for (const s of this.servers.values()) {
          if (!s.config.enabled || this.inCooloff(s)) continue;
          const specs = await this.listTools(s.config.id);
          for (const spec of specs) {
            const fqName = mcpToolName(s.config.id, spec.name);
            result.push({
              definition: {
                name: fqName,
                description: spec.description ?? `MCP 工具 ${spec.name}（来自 ${s.config.id}）`,
                parameters: spec.inputSchema ?? { type: "object", properties: {} },
              },
              source: "mcp",
              requiresApproval: "first-use",
              // 用「每次调用」的 ctx.signal（pi 经 toPiTool 传入），而非 provider 级 tools(ctx) 的 ctx
              // —— 后者在宿主层是个永不 abort 的占位 signal，否则取消/超时无法中断在途 MCP 调用。
              execute: (args, exec) => this.callTool(s.config.id, spec.name, args, exec?.signal ?? ctx.signal),
            });
          }
        }
        return result;
      },
    };
  }
}
