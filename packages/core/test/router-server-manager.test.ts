import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { EngineRegistry } from "../src/engine/registry.js";
import { RouterServerManager } from "../src/engine/router-server-manager.js";
import { createCore } from "../src/server/app.js";

const MODELS_DIR = "/models";
const CHAT_ID = "unsloth__Qwen3-4B-GGUF";
const EMBED_ID = "nomic-ai__nomic-embed-text-v1.5-GGUF";
const CHAT_PATH = path.join(MODELS_DIR, CHAT_ID, "Qwen3-4B-Q4_K_M.gguf");

interface Spawned {
  bin: string;
  args: string[];
}

/** 假 router 环境：捕获 spawn 调用 + 应答 health / /v1/models / load|unload / chat。 */
function makeFakes() {
  const spawns: Spawned[] = [];
  const procs: EventEmitter[] = [];
  const chatBodies: Record<string, unknown>[] = [];
  const spawnFn = ((bin: string, args: string[]) => {
    spawns.push({ bin, args });
    const proc = Object.assign(new EventEmitter(), { kill: () => true });
    procs.push(proc);
    return proc;
  }) as never;

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/health")) return new Response("{}", { status: 200 });
    if (url.endsWith("/v1/models") && (!init || init.method !== "POST")) {
      return new Response(
        JSON.stringify({ data: [{ id: CHAT_ID }, { id: EMBED_ID }] }),
        { status: 200 },
      );
    }
    if (url.endsWith("/v1/models/load") || url.endsWith("/v1/models/unload")) {
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    if (url.endsWith("/chat/completions")) {
      chatBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: {} }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected ${url} ${init?.method ?? "GET"}`);
  }) as unknown as typeof fetch;

  return { spawns, procs, chatBodies, spawnFn, fetchImpl };
}

describe("RouterServerManager", () => {
  it("起单个 router 进程、按 routerId 路由、过滤嵌入模型、上下文映射", async () => {
    const { spawns, spawnFn, fetchImpl } = makeFakes();
    const registry = new EngineRegistry();
    const mgr = new RouterServerManager(registry, {
      binaryPath: "/usr/bin/llama",
      modelsDir: MODELS_DIR,
      modelsMax: 4,
      spawnFn,
      fetch: fetchImpl,
      readyTimeoutMs: 2000,
      contextsProvider: async () => ({ [CHAT_ID]: 32768 }),
    });

    const r1 = await mgr.load({ modelPath: CHAT_PATH, contextSize: 4096 });
    expect(r1.id).toBe(CHAT_ID); // 返回 routerId（非路径）
    expect(r1.contextSize).toBe(32768); // 来自 contextsProvider
    await mgr.load({ modelPath: CHAT_PATH }); // 二次 load 不应再起进程

    expect(spawns.length).toBe(1); // 只起 1 个 router
    expect(spawns[0]!.bin).toBe("/usr/bin/llama");
    expect(spawns[0]!.args).toEqual(
      expect.arrayContaining(["serve", "--models-dir", MODELS_DIR, "--models-max", "4", "--host", "127.0.0.1"]),
    );

    // 路由用 routerId，嵌入模型被过滤
    expect(registry.routedModels()).toContain(CHAT_ID);
    expect(registry.routedModels()).not.toContain(EMBED_ID);
    expect(() => registry.resolve(CHAT_ID)).not.toThrow();

    // baseUrlFor 同时认 routerId 与路径（路径会归一化）
    expect(mgr.baseUrlFor(CHAT_ID)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    expect(mgr.baseUrlFor(CHAT_PATH)).toBe(mgr.baseUrlFor(CHAT_ID));
    expect(mgr.baseUrlFor("some-cloud-model")).toBeUndefined();

    expect(mgr.contexts()[CHAT_ID]).toBe(32768);
    expect(mgr.loadedIds()).toEqual([CHAT_ID]);
    await mgr.stopAll();
  });

  it("包装引擎对任意入参强制 model = routerId", async () => {
    const { chatBodies, spawnFn, fetchImpl } = makeFakes();
    const registry = new EngineRegistry();
    const mgr = new RouterServerManager(registry, {
      binaryPath: "/usr/bin/llama",
      modelsDir: MODELS_DIR,
      spawnFn,
      fetch: fetchImpl,
      readyTimeoutMs: 2000,
    });
    await mgr.load({ modelPath: CHAT_PATH });
    const engine = registry.resolve(CHAT_ID);
    await engine.chat({ model: "WHATEVER_CALLER_SENT", messages: [{ role: "user", content: "hi" }] });
    expect(chatBodies.at(-1)?.model).toBe(CHAT_ID); // 出站 model 被固定为 routerId
    await mgr.stopAll();
  });

  it("applyNet(0.0.0.0 + key) 重启 router 且带 --host/--api-key", async () => {
    const { spawns, spawnFn, fetchImpl } = makeFakes();
    const registry = new EngineRegistry();
    const mgr = new RouterServerManager(registry, {
      binaryPath: "/usr/bin/llama",
      modelsDir: MODELS_DIR,
      spawnFn,
      fetch: fetchImpl,
      readyTimeoutMs: 2000,
    });
    await mgr.load({ modelPath: CHAT_PATH });
    expect(spawns.length).toBe(1);
    await mgr.applyNet({ bindHost: "0.0.0.0", apiKey: "secret" });
    expect(spawns.length).toBe(2); // 重启
    expect(spawns[1]!.args).toEqual(expect.arrayContaining(["--host", "0.0.0.0", "--api-key", "secret"]));
    expect(mgr.getBindHost()).toBe("0.0.0.0");
    expect(mgr.getApiKey()).toBe("secret");
    await mgr.stopAll();
  });
});

describe("createCore 本地后端", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ew-be-"));
  it("统一 llama → RouterServerManager 带 binaryPath；经典 llama-server → 无 binaryPath", () => {
    const a = createCore({ llamaServerPath: "llama", modelsDir: tmp, memoryDbPath: ":memory:", kbDbPath: ":memory:" });
    expect(a.local).toBeInstanceOf(RouterServerManager);
    expect(a.local.binaryPathOf()).toBe("llama");

    const b = createCore({ llamaServerPath: "llama-server", modelsDir: tmp, memoryDbPath: ":memory:", kbDbPath: ":memory:" });
    expect(b.local.binaryPathOf()).toBeUndefined(); // 只有经典 llama-server → router 不启用，提示装统一 llama
  });
});
