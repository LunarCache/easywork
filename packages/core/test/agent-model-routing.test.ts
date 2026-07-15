import { describe, expect, it } from "vitest";
import { EngineRegistry } from "../src/engine/registry.js";
import { ProviderModelConfiguration } from "../src/providers/model-configuration.js";
import { ProviderManager } from "../src/providers/manager.js";
import { agentModelUnavailableError } from "../src/server/app.js";

describe("agent model routing preflight", () => {
  it("accepts a configured stale pi-native identity without resolving its runtime model", () => {
    const registry = new EngineRegistry();
    const providers = new ProviderManager(registry, {
      modelConfiguration: new ProviderModelConfiguration({
        providers: () => [],
        model: () => undefined,
      }),
    });

    providers.add({
      id: "deep/seek",
      kind: "pi-native",
      api: "openai-completions",
      apiKey: "secret-key",
      modelConfigs: [{ id: "deepseek/v4-flash", contextWindow: 1000000, inputModalities: ["text"] }],
    });

    expect(agentModelUnavailableError("deepseek/v4-flash", registry, providers)).toBeNull();
    expect(agentModelUnavailableError(
      "provider:deep%2fseek:deepseek%2fv4-flash",
      registry,
      providers,
    )).toBeNull();
  });

  it("rejects unknown models", () => {
    const registry = new EngineRegistry();
    const providers = new ProviderManager(registry);

    expect(agentModelUnavailableError("missing-model", registry, providers)?.message).toContain("missing-model");
  });
});
