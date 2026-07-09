import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { AgentProviderRuntime } from "../src/agent/provider-runtime.js";
import { SessionHost } from "../src/agent/session-host.js";
import type { LocalBackend } from "../src/engine/local-backend.js";
import { parseProviderModelRouteId, providerModelRouteId } from "../src/providers/catalog.js";
import type { ProviderManager, CloudProviderConfig } from "../src/providers/manager.js";

// R2：把 EasyWork 云端 provider 同步进 pi 的共享、落盘 AuthStorage，并能全量对账（增/删）。
function makeDeps(configs: CloudProviderConfig[]) {
  const local = { baseUrlFor: () => undefined, contexts: () => ({}) } as unknown as LocalBackend;
  let dump = configs;
  const resolveModelRef = (id: string) => {
    const scoped = parseProviderModelRouteId(id);
    if (scoped) {
      const config = dump.find((c) => c.id === scoped.providerId && c.modelConfigs.some((m) => m.id === scoped.modelId));
      return config ? { config, routeId: id, modelId: scoped.modelId } : undefined;
    }
    const config = dump.find((c) => c.modelConfigs.some((m) => m.id === id));
    return config ? { config, routeId: providerModelRouteId(config.id, id), modelId: id } : undefined;
  };
  const providers = {
    dump: () => dump,
    findByModel: (id: string) => resolveModelRef(id)?.config,
    resolveModelRef,
    setDump: (next: CloudProviderConfig[]) => {
      dump = next;
    },
  } as unknown as ProviderManager & { setDump: (n: CloudProviderConfig[]) => void };
  return { local, providers };
}

function makeRuntime(configs: CloudProviderConfig[], agentDir: string) {
  const deps = makeDeps(configs);
  return {
    ...deps,
    runtime: new AgentProviderRuntime({ ...deps, agentDir }),
  };
}

describe("AgentProviderRuntime", () => {
  it("seeds local key + persists cloud provider key, and reconciles removals", () => {
    const agentDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ew-r2-")));
    const cfg: CloudProviderConfig = {
      id: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "sk-test-123",
      modelConfigs: [{ id: "some/model", contextWindow: 32768, inputModalities: ["text"] }],
    };
    const { providers, runtime } = makeRuntime([cfg], agentDir);

    // 重新打开同一 auth.json，断言持久化结果（与 host 内句柄解耦）。
    const reopened = () => AuthStorage.create(path.join(agentDir, "auth.json"));
    let store = reopened();
    expect(store.get("local")).toEqual({ type: "api_key", key: "local" });
    expect(store.get("openrouter")).toEqual({ type: "api_key", key: "sk-test-123" });

    // 删除该 provider 后对账 → 凭据被注销。
    (providers as unknown as { setDump: (n: CloudProviderConfig[]) => void }).setDump([]);
    runtime.syncCloudProviders();
    store = reopened();
    expect(store.get("openrouter")).toBeUndefined();
    expect(store.get("local")).toEqual({ type: "api_key", key: "local" });

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
    const { runtime } = makeRuntime([cfg], agentDir);

    const resolved = runtime.resolveModel("claude-haiku-4-5");
    expect(resolved.provider).toBe("anthropic");
    expect(resolved.api).toBe("anthropic-messages");
    expect(resolved.contextWindow).toBe(200000);

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
    const { providers, runtime } = makeRuntime([cfg], agentDir);

    (providers as unknown as { setDump: (n: CloudProviderConfig[]) => void }).setDump([]);
    runtime.syncCloudProviders();

    const store = AuthStorage.create(authPath);
    expect(store.get("anthropic")).toEqual({ type: "api_key", key: "existing-key" });

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
    const { runtime } = makeRuntime([cfg], agentDir);

    const resolve = runtime.resolveModel.bind(runtime);
    expect(resolve("text-only")).toMatchObject({ contextWindow: 32768, input: ["text"] });
    expect(resolve("vision-model")).toMatchObject({ contextWindow: 131072, input: ["text", "image"] });

    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("resolves provider-scoped route ids without leaking them to pi model ids", () => {
    const agentDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ew-scoped-models-")));
    const { runtime } = makeRuntime([{
      id: "custom-deepseek",
      kind: "openai-compatible",
      api: "openai-completions",
      baseUrl: "https://example.test/v1",
      apiKey: "sk-test",
      modelConfigs: [{ id: "deepseek-v4", contextWindow: 32768, inputModalities: ["text"] }],
    }], agentDir);

    const resolved = runtime.resolveModel("provider:custom-deepseek:deepseek-v4");
    expect(resolved).toMatchObject({
      id: "deepseek-v4",
      provider: "custom-deepseek",
      contextWindow: 32768,
    });

    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("throws on unresolvable model", () => {
    const agentDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ew-r2-")));
    const { runtime } = makeRuntime([], agentDir);
    expect(fs.existsSync(path.join(agentDir, "auth.json"))).toBe(true);
    expect(() => runtime.resolveModel("missing-model")).toThrow("model_not_resolvable: missing-model");
    fs.rmSync(agentDir, { recursive: true, force: true });
  });
});

describe("SessionHost runtime settings", () => {
  it("调低 compaction.reserveTokens（防小上下文模型每轮压缩）", () => {
    const agentDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ew-tune-")));
    const host = new SessionHost({ ...makeDeps([]), agentDir });
    const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
    expect(settings.compaction.reserveTokens).toBe(2048);
    host.disposeAll();
    fs.rmSync(agentDir, { recursive: true, force: true });
  });
});
