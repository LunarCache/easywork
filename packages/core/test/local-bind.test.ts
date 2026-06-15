import { describe, it, expect } from "vitest";
import type { ChatStreamEvent } from "@ew/shared";
import { EngineRegistry } from "../src/engine/registry.js";
import { LocalServerManager, type LocalEngineLike } from "../src/engine/local-server-manager.js";

function fakeEngine(id: string): LocalEngineLike {
  return {
    id,
    capabilities: { streaming: true, tools: false, vision: false, embeddings: false },
    async chat() {
      return { message: { role: "assistant", content: "" }, finishReason: "stop" as const };
    },
    // eslint-disable-next-line require-yield
    async *chatStream(): AsyncIterable<ChatStreamEvent> {
      return;
    },
    async start() {},
    async stop() {},
  };
}

describe("LocalServerManager 绑定 host", () => {
  it("默认 127.0.0.1：engine 收到 host、endpoints 报告、baseUrlFor 走回环", async () => {
    const hosts: string[] = [];
    const registry = new EngineRegistry();
    const mgr = new LocalServerManager(registry, {
      makeEngine: (id, o) => {
        hosts.push(o.host ?? "");
        return fakeEngine(id);
      },
    });
    await mgr.load({ modelPath: "/m/a.gguf" });
    expect(hosts).toEqual(["127.0.0.1"]);
    expect(mgr.getBindHost()).toBe("127.0.0.1");
    const eps = mgr.endpoints();
    expect(eps[0]).toMatchObject({ id: "/m/a.gguf", host: "127.0.0.1" });
    expect(eps[0]!.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    expect(mgr.baseUrlFor("/m/a.gguf")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    await mgr.stopAll();
  });

  it("setBindHost(0.0.0.0)：重载已加载模型、对外端点用 0.0.0.0，但内部 baseUrlFor 仍回环", async () => {
    const hosts: string[] = [];
    const registry = new EngineRegistry();
    const mgr = new LocalServerManager(registry, {
      makeEngine: (id, o) => {
        hosts.push(o.host ?? "");
        return fakeEngine(id);
      },
    });
    await mgr.load({ modelPath: "/m/a.gguf" });
    await mgr.setBindHost("0.0.0.0");

    expect(hosts).toEqual(["127.0.0.1", "0.0.0.0"]); // 重载了一次，用新 host
    expect(mgr.getBindHost()).toBe("0.0.0.0");
    expect(mgr.loadedIds()).toEqual(["/m/a.gguf"]); // 仍加载
    expect(mgr.endpoints()[0]!.baseUrl).toMatch(/^http:\/\/0\.0\.0\.0:\d+\/v1$/);
    // 内部代理/agent 始终走回环（0.0.0.0 也含 loopback）。
    expect(mgr.baseUrlFor("/m/a.gguf")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    await mgr.stopAll();
  });

  it("初始 bindHost 选项透传给 engine", async () => {
    const hosts: string[] = [];
    const registry = new EngineRegistry();
    const mgr = new LocalServerManager(registry, {
      bindHost: "0.0.0.0",
      makeEngine: (id, o) => {
        hosts.push(o.host ?? "");
        return fakeEngine(id);
      },
    });
    await mgr.load({ modelPath: "/m/a.gguf" });
    expect(hosts).toEqual(["0.0.0.0"]);
    await mgr.stopAll();
  });

  it("applyNet 同时切 host+apiKey：透传 --api-key 并报告", async () => {
    const recs: { host?: string; apiKey?: string }[] = [];
    const registry = new EngineRegistry();
    const mgr = new LocalServerManager(registry, {
      makeEngine: (id, o) => {
        recs.push({ host: o.host, apiKey: o.apiKey });
        return fakeEngine(id);
      },
    });
    await mgr.load({ modelPath: "/m/a.gguf" });
    await mgr.applyNet({ bindHost: "0.0.0.0", apiKey: "secret" });
    expect(mgr.getApiKey()).toBe("secret");
    expect(mgr.getBindHost()).toBe("0.0.0.0");
    expect(recs.at(-1)).toEqual({ host: "0.0.0.0", apiKey: "secret" });
    await mgr.stopAll();
  });

  it("重载中途单模型失败不连累其余（不清空全部）", async () => {
    const starts: Record<string, number> = {};
    const registry = new EngineRegistry();
    const mgr = new LocalServerManager(registry, {
      makeEngine: (id) => ({
        ...fakeEngine(id),
        async start() {
          starts[id] = (starts[id] ?? 0) + 1;
          if (starts[id] === 2 && id.includes("a.gguf")) throw new Error("rebind failed");
        },
      }),
    });
    await mgr.load({ modelPath: "/m/a.gguf" });
    await mgr.load({ modelPath: "/m/b.gguf" });
    await mgr.applyNet({ bindHost: "0.0.0.0", apiKey: "k" }); // a 重载失败、b 成功
    expect(mgr.loadedIds()).toEqual(["/m/b.gguf"]); // a 掉了，但 b 仍在（未被连累清空）
    await mgr.stopAll();
  });
});
