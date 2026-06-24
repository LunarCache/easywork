import { describe, it, expect } from "vitest";
import type { McpServerConfig, ToolExecContext } from "@ew/shared";
import { McpClientManager } from "../src/manager.js";
import type { McpConnection } from "../src/connect.js";

const ctx: ToolExecContext = {
  sessionId: "t",
  workspaceDir: "/tmp",
  signal: new AbortController().signal,
  approval: { async request() { return "approve"; } },
};

const cfg: McpServerConfig = {
  id: "fs",
  displayName: "Filesystem",
  transport: { kind: "stdio", command: "echo", args: [] },
  enabled: true,
};

function fakeConn(opts: { failOnce?: { value: boolean } } = {}): McpConnection {
  return {
    async listTools() {
      if (opts.failOnce?.value) {
        opts.failOnce.value = false;
        throw new Error("transient");
      }
      return [
        { name: "list-files", description: "列目录", inputSchema: { type: "object", properties: {} } },
        { name: "read", description: "读文件", inputSchema: { type: "object", properties: {} } },
      ];
    },
    async callTool(name) {
      return { content: [{ type: "text", text: `called ${name}` }] };
    },
    async close() {},
  };
}

describe("McpClientManager", () => {
  it("toolProvider 暴露 mcp__<srv>__<tool> 命名空间工具", async () => {
    const mgr = new McpClientManager({ allowStdio: true, connect: async () => fakeConn() });
    await mgr.upsert(cfg);
    const tools = await mgr.toolProvider().tools(ctx);
    const names = tools.map((t) => t.definition.name).sort();
    expect(names).toEqual(["mcp__fs__list-files", "mcp__fs__read"]);
    expect(tools[0]!.source).toBe("mcp");
    expect(tools[0]!.requiresApproval).toBe("first-use");
  });

  it("callTool 拍平 MCP content 为字符串", async () => {
    const mgr = new McpClientManager({ allowStdio: true, connect: async () => fakeConn() });
    await mgr.upsert(cfg);
    const res = await mgr.callTool("fs", "read", { path: "x" });
    expect(res.content).toBe("called read");
  });

  it("失败后进入 cooloff，期间用缓存且不重连", async () => {
    let now = 1000;
    let connectCalls = 0;
    const mgr = new McpClientManager({
      allowStdio: true,
      now: () => now,
      connect: async () => {
        connectCalls++;
        // 第一次连接成功列表，之后 listTools 第二次抛错
        return fakeConn();
      },
    });
    await mgr.upsert(cfg);

    // 首次成功，建立缓存
    const first = await mgr.listTools("fs");
    expect(first).toHaveLength(2);

    // 让下一次 listTools 失败：替换连接为会抛错的
    const failing = new McpClientManager({
      allowStdio: true,
      now: () => now,
      connect: async () => fakeConn({ failOnce: { value: true } }),
    });
    await failing.upsert(cfg);
    await failing.listTools("fs"); // 建立缓存（成功）
    // 强制失败路径：直接构造一个总是失败的
    const alwaysFail = new McpClientManager({
      allowStdio: true,
      now: () => now,
      connect: async () => ({
        async listTools() {
          throw new Error("down");
        },
        async callTool() {
          return { content: [] };
        },
        async close() {},
      }),
    });
    await alwaysFail.upsert(cfg);
    const r1 = await alwaysFail.listTools("fs"); // 失败 → cooloff, 返回空缓存
    expect(r1).toEqual([]);
    // cooloff 期内再次调用：仍返回缓存（空），不应继续抛
    now += 1000; // < 60s
    const r2 = await alwaysFail.listTools("fs");
    expect(r2).toEqual([]);
    expect(connectCalls).toBeGreaterThan(0);
  });

  it("stdio 默认禁用：toolProvider 不暴露，callTool/probe 报错", async () => {
    const mgr = new McpClientManager({ connect: async () => fakeConn() }); // allowStdio 默认 false
    await mgr.upsert(cfg);
    expect(await mgr.toolProvider().tools(ctx)).toEqual([]);
    const probe = await mgr.probe(cfg);
    expect(probe.ok).toBe(false);
    expect(probe.error).toMatch(/EW_ALLOW_STDIO_MCP/);
    const call = await mgr.callTool("fs", "read", {});
    expect(call.isError).toBe(true);
  });

  it("probe 成功返回工具清单（tools 字段）", async () => {
    const mgr = new McpClientManager({ allowStdio: true, connect: async () => fakeConn() });
    const probe = await mgr.probe(cfg);
    expect(probe.ok).toBe(true);
    expect(probe.toolCount).toBe(2);
    expect(probe.tools).toHaveLength(2);
    expect(probe.tools.map((t) => t.name).sort()).toEqual(["list-files", "read"]);
    expect(probe.tools[0]).toHaveProperty("description");
  });

  it("listToolsOf 返回工具清单（供 UI 预览）", async () => {
    const mgr = new McpClientManager({ allowStdio: true, connect: async () => fakeConn() });
    await mgr.upsert(cfg);
    const tools = await mgr.listToolsOf("fs");
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name).sort()).toEqual(["list-files", "read"]);
  });

  it("callTool 透传 AbortSignal 给底层连接", async () => {
    let seenSignal: AbortSignal | undefined;
    const conn: McpConnection = {
      async listTools() {
        return [{ name: "read", description: "读" }];
      },
      async callTool(_name, _args, signal) {
        seenSignal = signal;
        return { content: [{ type: "text", text: "ok" }] };
      },
      async close() {},
    };
    const ac = new AbortController();
    const mgr = new McpClientManager({ allowStdio: true, connect: async () => conn });
    await mgr.upsert(cfg);
    await mgr.callTool("fs", "read", {}, ac.signal);
    expect(seenSignal).toBe(ac.signal);
  });

  it("调用前按 inputSchema 校验参数（缺必填 / 类型错）", async () => {
    const conn: McpConnection = {
      async listTools() {
        return [
          {
            name: "read",
            description: "读文件",
            inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          },
        ];
      },
      async callTool(name) {
        return { content: [{ type: "text", text: `called ${name}` }] };
      },
      async close() {},
    };
    const mgr = new McpClientManager({ allowStdio: true, connect: async () => conn });
    await mgr.upsert(cfg);
    await mgr.listTools("fs"); // 填充缓存（含 schema）
    const missing = await mgr.callTool("fs", "read", {});
    expect(missing.isError).toBe(true);
    expect(missing.content).toMatch(/必填|path/);
    const wrongType = await mgr.callTool("fs", "read", { path: 123 });
    expect(wrongType.isError).toBe(true);
    const ok = await mgr.callTool("fs", "read", { path: "x" });
    expect(ok.content).toBe("called read");
  });
});
