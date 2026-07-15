import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { streamSimple } from "@earendil-works/pi-ai";
import { AgentProviderRuntime } from "../src/agent/provider-runtime.js";
import { SessionHost } from "../src/agent/session-host.js";
import { EngineRegistry } from "../src/engine/registry.js";
import type { LocalBackend } from "../src/engine/local-backend.js";
import { ProviderManager, type CloudProviderConfig } from "../src/providers/manager.js";

// R2：把 EasyWork 云端 provider 同步进 pi 的共享、落盘 AuthStorage，并能全量对账（增/删）。
function makeDeps(configs: CloudProviderConfig[]) {
  const local = { baseUrlFor: () => undefined, contexts: () => ({}) } as unknown as LocalBackend;
  const providers = new ProviderManager(new EngineRegistry());
  for (const config of configs) providers.add(config);
  const setDump = (next: CloudProviderConfig[]) => {
    for (const config of providers.dump()) providers.remove(config.id);
    for (const config of next) providers.add(config);
  };
  return { local, providers, setDump };
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
    const { runtime, setDump } = makeRuntime([cfg], agentDir);

    // 重新打开同一 auth.json，断言持久化结果（与 host 内句柄解耦）。
    const reopened = () => AuthStorage.create(path.join(agentDir, "auth.json"));
    let store = reopened();
    expect(store.get("local")).toEqual({ type: "api_key", key: "local" });
    expect(store.get("openrouter")).toEqual({ type: "api_key", key: "sk-test-123" });

    // 删除该 provider 后对账 → 凭据被注销。
    setDump([]);
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
    const { runtime, setDump } = makeRuntime([cfg], agentDir);

    setDump([]);
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

  it("keeps custom provider auth scope while applying pi catalog model compatibility", () => {
    const agentDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ew-catalog-model-")));
    const { runtime } = makeRuntime([{
      id: "cloudprime",
      kind: "openai-compatible",
      api: "openai-completions",
      baseUrl: "https://cloudprime.example/v1",
      apiKey: "sk-cloudprime",
      modelConfigs: [{
        id: "deepseek-v4-pro",
        contextWindow: 977000,
        inputModalities: ["text"],
        catalogRef: { providerId: "deepseek", modelId: "deepseek-v4-pro" },
      }],
    }], agentDir);

    const resolved = runtime.resolveModel("provider:cloudprime:deepseek-v4-pro");
    expect(resolved).toMatchObject({
      id: "deepseek-v4-pro",
      provider: "cloudprime",
      baseUrl: "https://cloudprime.example/v1",
      reasoning: true,
      compat: {
        supportsDeveloperRole: false,
        requiresReasoningContentOnAssistantMessages: true,
        thinkingFormat: "deepseek",
      },
    });
    expect(runtime.authStorage.get("cloudprime")).toEqual({ type: "api_key", key: "sk-cloudprime" });

    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("serializes catalog-backed custom DeepSeek prompts with a system role", async () => {
    const agentDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ew-deepseek-role-")));
    const { runtime } = makeRuntime([{
      id: "cloudprime",
      kind: "openai-compatible",
      api: "openai-completions",
      baseUrl: "https://cloudprime.example/v1",
      apiKey: "sk-cloudprime",
      modelConfigs: [{
        id: "deepseek-v4-pro",
        contextWindow: 977000,
        inputModalities: ["text"],
        catalogRef: { providerId: "deepseek", modelId: "deepseek-v4-pro" },
      }],
    }], agentDir);
    let payload: { messages?: Array<{ role?: string }> } | undefined;
    const stream = streamSimple(runtime.resolveModel("provider:cloudprime:deepseek-v4-pro"), {
      systemPrompt: "You are EasyWork.",
      messages: [{ role: "user", content: "hello", timestamp: 0 }],
    }, {
      apiKey: "sk-cloudprime",
      onPayload: (value) => {
        payload = value as typeof payload;
        throw new Error("payload captured");
      },
    });

    const result = await stream.result();
    expect(result).toMatchObject({ stopReason: "error", errorMessage: "payload captured" });
    expect(payload?.messages?.[0]?.role).toBe("system");

    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("advances only cloud model revisions when provider registrations are refreshed", () => {
    const agentDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ew-provider-revision-")));
    const { providers, runtime } = makeRuntime([{
      id: "cloud",
      kind: "openai-compatible",
      baseUrl: "https://cloud.example/v1",
      apiKey: "sk-cloud",
      modelConfigs: [{ id: "model-a", contextWindow: 32768, inputModalities: ["text"] }],
    }], agentDir);
    const routeId = providers.modelIds()[0]!;
    const before = runtime.modelRevision(routeId);

    runtime.syncCloudProviders();

    expect(runtime.modelRevision(routeId)).toBe(before + 1);
    expect(runtime.modelRevision("local-model")).toBe(0);
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

describe("SessionHost thread lifecycle barrier", () => {
  it("rejects a history commit queued behind deletion", async () => {
    const agentDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ew-delete-barrier-")));
    const host = new SessionHost({ ...makeDeps([]), agentDir });
    try {
      let deletionStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        deletionStarted = resolve;
      });
      let releaseDeletion!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseDeletion = resolve;
      });
      const deletion = host.deleteThread("t1", async () => {
        deletionStarted();
        await gate;
      });
      await started;

      let committed = false;
      const lateCommit = host.commitThread("t1", () => {
        committed = true;
      });
      releaseDeletion();

      await deletion;
      expect(await lateCommit).toBe(false);
      expect(committed).toBe(false);
    } finally {
      host.disposeAll();
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("keeps a permanent deletion tombstone when empty-shell discard races behind an active turn", async () => {
    const agentDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ew-delete-discard-race-")));
    const host = new SessionHost({ ...makeDeps([]), agentDir });
    try {
      const claim = await host.claimThreadRun("t-race", () => true);
      expect(claim).not.toBeNull();
      let turnStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        turnStarted = resolve;
      });
      let releaseTurn!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseTurn = resolve;
      });
      const activeTurn = host.commitThread("t-race", async () => {
        turnStarted();
        await gate;
      });
      await started;

      let permanentlyDeleted = false;
      let transientlyDiscarded = false;
      const deletion = host.deleteThread("t-race", () => {
        permanentlyDeleted = true;
      });
      const discard = host.discardEmptyThread("t-race", claim!.attempt, {
        isEmpty: () => true,
        deletePersistentState: () => {
          transientlyDiscarded = true;
        },
      });
      releaseTurn();

      await Promise.all([activeTurn, deletion, discard]);
      expect(permanentlyDeleted).toBe(true);
      expect(transientlyDiscarded).toBe(false);
      expect(host.isThreadDeleted("t-race")).toBe(true);
    } finally {
      host.disposeAll();
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("does not let an old empty-shell discard delete a newer queued turn", async () => {
    const agentDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ew-discard-newer-turn-")));
    const host = new SessionHost({ ...makeDeps([]), agentDir });
    try {
      const firstClaim = await host.claimThreadRun("t-newer", () => true);
      expect(firstClaim).not.toBeNull();
      let firstStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        firstStarted = resolve;
      });
      let releaseFirst!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const activeFirst = host.commitThread("t-newer", async () => {
        firstStarted();
        await gate;
      });
      await started;

      const secondClaimPending = host.claimThreadRun("t-newer", () => true);
      let oldStateDeleted = false;
      const oldDiscard = host.discardEmptyThread("t-newer", firstClaim!.attempt, {
        isEmpty: () => true,
        deletePersistentState: () => {
          oldStateDeleted = true;
        },
      });
      releaseFirst();

      expect(await activeFirst).toBe(true);
      const secondClaim = await secondClaimPending;
      expect(secondClaim).not.toBeNull();
      let newerCommitted = false;
      const queuedSecond = host.commitThread("t-newer", () => {
        newerCommitted = true;
      });
      expect(await queuedSecond).toBe(true);
      expect(await oldDiscard).toBe(false);
      expect(newerCommitted).toBe(true);
      expect(oldStateDeleted).toBe(false);
      expect(host.isThreadDeleted("t-newer")).toBe(false);
    } finally {
      host.disposeAll();
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
