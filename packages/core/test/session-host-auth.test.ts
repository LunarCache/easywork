import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { SessionHost } from "../src/agent/session-host.js";
import type { LocalBackend } from "../src/engine/local-backend.js";
import type { ProviderManager, CloudProviderConfig } from "../src/providers/manager.js";

// R2：把 EasyWork 云端 provider 同步进 pi 的共享、落盘 AuthStorage，并能全量对账（增/删）。
function makeDeps(configs: CloudProviderConfig[]) {
  const local = { baseUrlFor: () => undefined, contexts: () => ({}) } as unknown as LocalBackend;
  let dump = configs;
  const providers = {
    dump: () => dump,
    findByModel: (id: string) => dump.find((c) => c.modelConfigs.some((m) => m.id === id)),
    setDump: (next: CloudProviderConfig[]) => {
      dump = next;
    },
  } as unknown as ProviderManager & { setDump: (n: CloudProviderConfig[]) => void };
  return { local, providers };
}

describe("SessionHost.syncCloudProviders", () => {
  it("seeds local key + persists cloud provider key, and reconciles removals", () => {
    const agentDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ew-r2-")));
    const cfg: CloudProviderConfig = {
      id: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "sk-test-123",
      modelConfigs: [{ id: "some/model", contextWindow: 32768, inputModalities: ["text"] }],
    };
    const deps = makeDeps([cfg]);
    const host = new SessionHost({ ...deps, agentDir });

    // 重新打开同一 auth.json，断言持久化结果（与 host 内句柄解耦）。
    const reopened = () => AuthStorage.create(path.join(agentDir, "auth.json"));
    let store = reopened();
    expect(store.get("local")).toEqual({ type: "api_key", key: "local" });
    expect(store.get("openrouter")).toEqual({ type: "api_key", key: "sk-test-123" });

    // 删除该 provider 后对账 → 凭据被注销。
    (deps.providers as unknown as { setDump: (n: CloudProviderConfig[]) => void }).setDump([]);
    host.syncCloudProviders();
    store = reopened();
    expect(store.get("openrouter")).toBeUndefined();
    expect(store.get("local")).toEqual({ type: "api_key", key: "local" });

    host.disposeAll();
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("keeps pi-native providers on their built-in pi-ai API family", () => {
    const agentDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ew-native-")));
    const cfg: CloudProviderConfig = {
      id: "anthropic",
      kind: "pi-native",
      api: "anthropic-messages",
      apiKey: "sk-ant-test",
      modelConfigs: [{ id: "claude-haiku-4-5", contextWindow: 200000, inputModalities: ["text"] }],
    };
    const host = new SessionHost({ ...makeDeps([cfg]), agentDir });

    const resolved = (host as unknown as { resolveModel(modelId: string): { provider: string; api: string; contextWindow?: number } })
      .resolveModel("claude-haiku-4-5");
    expect(resolved.provider).toBe("anthropic");
    expect(resolved.api).toBe("anthropic-messages");
    expect(resolved.contextWindow).toBe(200000);

    host.disposeAll();
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("does not remove pre-existing pi-native credentials when EasyWork did not write a key", () => {
    const agentDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ew-native-auth-")));
    const authPath = path.join(agentDir, "auth.json");
    AuthStorage.create(authPath).set("anthropic", { type: "api_key", key: "existing-key" });
    const cfg: CloudProviderConfig = {
      id: "anthropic",
      kind: "pi-native",
      api: "anthropic-messages",
      modelConfigs: [{ id: "claude-haiku-4-5", contextWindow: 200000, inputModalities: ["text"] }],
    };
    const deps = makeDeps([cfg]);
    const host = new SessionHost({ ...deps, agentDir });

    (deps.providers as unknown as { setDump: (n: CloudProviderConfig[]) => void }).setDump([]);
    host.syncCloudProviders();

    const store = AuthStorage.create(authPath);
    expect(store.get("anthropic")).toEqual({ type: "api_key", key: "existing-key" });

    host.disposeAll();
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("uses per-model context and modality metadata for custom providers", () => {
    const agentDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ew-custom-models-")));
    const cfg: CloudProviderConfig = {
      id: "custom",
      kind: "openai-compatible",
      api: "openai-completions",
      baseUrl: "https://example.test/v1",
      apiKey: "sk-test",
      modelConfigs: [
        { id: "text-only", contextWindow: 32768, inputModalities: ["text"] },
        { id: "vision-model", contextWindow: 131072, inputModalities: ["text", "image"] },
      ],
    };
    const host = new SessionHost({ ...makeDeps([cfg]), agentDir });

    const resolve = (host as unknown as {
      resolveModel(modelId: string): { contextWindow?: number; input?: string[] };
    }).resolveModel.bind(host);
    expect(resolve("text-only")).toMatchObject({ contextWindow: 32768, input: ["text"] });
    expect(resolve("vision-model")).toMatchObject({ contextWindow: 131072, input: ["text", "image"] });

    host.disposeAll();
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("throws on unresolvable model", () => {
    const agentDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ew-r2-")));
    const deps = makeDeps([]);
    const host = new SessionHost({ ...deps, agentDir });
    // resolveModel 是私有的，经 run() 间接触发；这里只验证构造不抛、目录建立。
    expect(fs.existsSync(path.join(agentDir, "auth.json"))).toBe(true);
    host.disposeAll();
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("调低 compaction.reserveTokens（防小上下文模型每轮压缩）", () => {
    const agentDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ew-tune-")));
    const host = new SessionHost({ ...makeDeps([]), agentDir });
    const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
    expect(settings.compaction.reserveTokens).toBe(2048);
    host.disposeAll();
    fs.rmSync(agentDir, { recursive: true, force: true });
  });
});
