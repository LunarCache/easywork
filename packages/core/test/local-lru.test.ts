import { describe, it, expect } from "vitest";
import type { ChatStreamEvent } from "@ew/shared";
import { EngineRegistry } from "../src/engine/registry.js";
import { LocalServerManager, type LocalEngineLike } from "../src/engine/local-server-manager.js";

function fakeEngine(id: string, stopped: string[]): LocalEngineLike {
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
    async stop() {
      stopped.push(id);
    },
  };
}

describe("LocalServerManager LRU 淘汰", () => {
  it("超过 maxLoaded 时卸载最久未用的模型", async () => {
    const stopped: string[] = [];
    const registry = new EngineRegistry();
    let clock = 1000;
    const mgr = new LocalServerManager(registry, {
      maxLoaded: 2,
      now: () => clock,
      makeEngine: (engineId) => fakeEngine(engineId, stopped),
    });

    clock = 1000;
    await mgr.load({ modelPath: "/m/a.gguf" });
    clock = 2000;
    await mgr.load({ modelPath: "/m/b.gguf" });

    // 使用 a → a 变为最近使用，b 成为 LRU。
    clock = 3000;
    const ea = registry.resolve("/m/a.gguf");
    for await (const _ of ea.chatStream({ model: "/m/a.gguf", messages: [] })) void _;

    // 加载第三个 → 应淘汰 b（最久未用）。
    clock = 4000;
    await mgr.load({ modelPath: "/m/c.gguf" });

    expect(stopped).toEqual(["local:b.gguf"]);
    expect(mgr.loadedIds().sort()).toEqual(["/m/a.gguf", "/m/c.gguf"]);
    await mgr.stopAll();
  });

  it("重复加载同一模型不新增、刷新 lastUsed", async () => {
    const stopped: string[] = [];
    const registry = new EngineRegistry();
    let clock = 1000;
    const mgr = new LocalServerManager(registry, {
      maxLoaded: 2,
      now: () => clock,
      makeEngine: (engineId) => fakeEngine(engineId, stopped),
    });
    await mgr.load({ modelPath: "/m/a.gguf" });
    clock = 5000;
    await mgr.load({ modelPath: "/m/a.gguf" });
    expect(mgr.loadedIds()).toEqual(["/m/a.gguf"]);
    await mgr.stopAll();
  });
});
