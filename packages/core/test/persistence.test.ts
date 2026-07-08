import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCore } from "../src/server/app.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ew-persist-"));
const dbPath = path.join(tmp, "conv.db");

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("provider / MCP 配置持久化", () => {
  it("provider 在重启（新 createCore 实例）后从 SQLite 恢复", async () => {
    const core1 = createCore({ dbPath, token: "t", memoryDbPath: ":memory:" });
    core1.providers.add({
      id: "openrouter",
      baseUrl: "https://example.com/v1",
      apiKey: "secret-key",
      modelConfigs: [{ id: "foo-model", contextWindow: 65536, inputModalities: ["text", "image"] }],
    });
    // 路由侧持久化由 HTTP 路由触发；这里直接写 setting 模拟（与路由一致）。
    core1.repo.setSetting("providers", JSON.stringify(core1.providers.dump()));
    await core1.stop();

    const core2 = createCore({ dbPath, token: "t", memoryDbPath: ":memory:" });
    const restored = core2.providers.dump();
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({
      id: "openrouter",
      baseUrl: "https://example.com/v1",
      apiKey: "secret-key",
      modelConfigs: [{ id: "foo-model", contextWindow: 65536, inputModalities: ["text", "image"] }],
    });
    expect(restored[0]).not.toHaveProperty("models");
    await core2.stop();
  });

  it("pi-native provider 配置在重启后保留 kind/api 且不需要 baseUrl", async () => {
    const nativeDbPath = path.join(tmp, "native-provider.db");
    const core1 = createCore({ dbPath: nativeDbPath, token: "t", memoryDbPath: ":memory:" });
    core1.providers.add({
      id: "anthropic",
      kind: "pi-native",
      api: "anthropic-messages",
      apiKey: "secret-key",
      modelConfigs: [{ id: "claude-haiku-4-5", contextWindow: 200000, inputModalities: ["text"] }],
    });
    core1.repo.setSetting("providers", JSON.stringify(core1.providers.dump()));
    await core1.stop();

    const core2 = createCore({ dbPath: nativeDbPath, token: "t", memoryDbPath: ":memory:" });
    const restored = core2.providers.dump();
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({
      id: "anthropic",
      kind: "pi-native",
      api: "anthropic-messages",
      apiKey: "secret-key",
      modelConfigs: [{ id: "claude-haiku-4-5", contextWindow: 200000, inputModalities: ["text"] }],
    });
    expect(restored[0].baseUrl).toBeUndefined();
    await core2.stop();
  });

  it("settings KV 读写/删除", () => {
    const core = createCore({ dbPath: ":memory:", token: "t", memoryDbPath: ":memory:" });
    core.repo.setSetting("k", "v1");
    expect(core.repo.getSetting("k")).toBe("v1");
    core.repo.setSetting("k", "v2");
    expect(core.repo.getSetting("k")).toBe("v2");
    core.repo.deleteSetting("k");
    expect(core.repo.getSetting("k")).toBeNull();
    void core.stop();
  });
});
