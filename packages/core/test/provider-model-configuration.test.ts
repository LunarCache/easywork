import { describe, expect, it } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import { ProviderModelConfiguration } from "../src/providers/model-configuration.js";

describe("Provider Model Configuration", () => {
  it("owns the final runtime model derived from saved configuration and catalog metadata", () => {
    const catalogModel = {
      id: "deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      api: "openai-completions",
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com",
      reasoning: true,
      thinkingLevelMap: { high: "high", xhigh: "max" },
      input: ["text", "image"],
      cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      compat: { thinkingFormat: "deepseek" },
    } as Model<Api>;
    const configuration = new ProviderModelConfiguration({
      providers: () => ["deepseek"],
      model: (providerId, modelId) => providerId === "deepseek" && modelId === catalogModel.id
        ? catalogModel
        : undefined,
    });

    const saved = configuration.normalize({
      id: "cloud/prime",
      baseUrl: "https://cloudprime.example/v1/",
      api: "anthropic-messages",
      headers: { "x-tenant": "prime" },
      modelConfigs: [{
        id: "deepseek-v4-pro",
        contextWindow: 64_000,
        inputModalities: ["text"],
        catalogRef: { providerId: "deepseek", modelId: "deepseek-v4-pro" },
      }],
    });
    const configured = configuration.resolve(saved, "provider:cloud%2Fprime:deepseek-v4-pro");

    expect(configured).toEqual({
      routeId: "provider:cloud%2Fprime:deepseek-v4-pro",
      upstreamModelId: "deepseek-v4-pro",
      runtimeModel: {
        id: "deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        api: "anthropic-messages",
        provider: "cloud/prime",
        baseUrl: "https://cloudprime.example/v1",
        reasoning: true,
        thinkingLevelMap: { high: "high", xhigh: "max" },
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 64_000,
        maxTokens: 128_000,
        headers: { "x-tenant": "prime" },
      },
    });
  });

  it("recomputes automatic catalog matching in Core and only pins explicit catalog mode", () => {
    const model = (provider: string, name: string) => ({
      id: "deepseek-v4-pro",
      name,
      api: "openai-completions",
      provider,
      baseUrl: `https://${provider}.example/v1`,
      reasoning: provider === "deepseek",
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 16_000,
    }) as Model<Api>;
    const deepseek = model("deepseek", "Core selected DeepSeek");
    const stale = model("stale", "Stale UI suggestion");
    const configuration = new ProviderModelConfiguration({
      providers: () => ["stale", "deepseek"],
      model: (providerId) => providerId === "deepseek" ? deepseek : providerId === "stale" ? stale : undefined,
    });
    const base = {
      id: "custom",
      baseUrl: "https://custom.example/v1",
      modelConfigs: [{
        id: "deepseek-v4-pro",
        contextWindow: 32_768,
        inputModalities: ["text"] as const,
        catalogRef: { providerId: "stale", modelId: "deepseek-v4-pro" },
      }],
    };

    expect(configuration.resolve(configuration.normalize(base), "deepseek-v4-pro")?.runtimeModel.name)
      .toBe("Core selected DeepSeek");
    expect(configuration.resolve(configuration.normalize({
      ...base,
      modelConfigs: [{ ...base.modelConfigs[0]!, compatibilityMode: "catalog" }],
    }), "deepseek-v4-pro")?.runtimeModel.name).toBe("Stale UI suggestion");
  });

  it("materializes compat only for the configured wire protocol", () => {
    const template = {
      id: "deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      api: "openai-completions",
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com",
      reasoning: true,
      input: ["text"],
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 16_000,
      compat: { thinkingFormat: "deepseek" },
    } as Model<Api>;
    const configuration = new ProviderModelConfiguration({
      providers: () => ["deepseek"],
      model: () => template,
    });
    const saved = (api: string) => configuration.normalize({
      id: "custom",
      baseUrl: "https://custom.example/v1",
      api,
      modelConfigs: [{ id: template.id, contextWindow: 32_768, inputModalities: ["text"] }],
    });

    expect(configuration.resolve(saved("openai-completions"), template.id)?.runtimeModel.compat).toMatchObject({
      thinkingFormat: "deepseek",
      supportsDeveloperRole: false,
      supportsStore: false,
      maxTokensField: "max_tokens",
    });
    expect(configuration.resolve(saved("anthropic-messages"), template.id)?.runtimeModel.compat).toBeUndefined();
  });

  it("allows each compatible model to override the provider API family", () => {
    const configuration = new ProviderModelConfiguration({
      providers: () => [],
      model: () => undefined,
    });
    const saved = configuration.normalize({
      id: "mixed-protocol",
      baseUrl: "https://mixed.example/v1",
      api: "openai-completions",
      modelConfigs: [
        {
          id: "openai-model",
          api: "openai-completions",
          contextWindow: 32_768,
          inputModalities: ["text"],
        },
        {
          id: "anthropic-model",
          api: "anthropic-messages",
          baseUrl: "https://mixed.example",
          contextWindow: 32_768,
          inputModalities: ["text"],
        },
      ],
    });

    expect(configuration.resolve(saved, "openai-model")?.runtimeModel.api).toBe("openai-completions");
    expect(configuration.resolve(saved, "anthropic-model")?.runtimeModel).toMatchObject({
      api: "anthropic-messages",
      baseUrl: "https://mixed.example",
    });
  });

  it("keeps pi-native protocol identity and cost while applying saved capability overrides", () => {
    const template = {
      id: "native-model",
      name: "Native Model",
      api: "anthropic-messages",
      provider: "native-provider",
      baseUrl: "https://native.example/v1",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 3, output: 9, cacheRead: 1, cacheWrite: 2 },
      contextWindow: 200_000,
      maxTokens: 32_000,
      compat: { supportsDeveloperRole: false },
    } as Model<Api>;
    const configuration = new ProviderModelConfiguration({
      providers: () => ["native-provider"],
      model: () => template,
    });
    const saved = configuration.normalize({
      id: "native-provider",
      kind: "pi-native",
      api: "openai-completions",
      modelConfigs: [{
        id: "native-model",
        contextWindow: 90_000,
        inputModalities: ["text"],
        reasoning: false,
      }],
    });

    expect(configuration.resolve(saved, "native-model")?.runtimeModel).toMatchObject({
      api: "anthropic-messages",
      provider: "native-provider",
      reasoning: false,
      input: ["text"],
      contextWindow: 90_000,
      maxTokens: 32_000,
      cost: { input: 3, output: 9, cacheRead: 1, cacheWrite: 2 },
      compat: { supportsDeveloperRole: false },
    });
  });

  it("never downgrades an unresolved pi-native model to a compatible wire protocol", () => {
    const configuration = new ProviderModelConfiguration({
      providers: () => ["native-provider"],
      model: () => undefined,
    });
    const saved = configuration.normalize({
      id: "native-provider",
      kind: "pi-native",
      api: "openai-completions",
      modelConfigs: [{
        id: "missing-native-model",
        contextWindow: 32_768,
        inputModalities: ["text"],
      }],
    });

    expect(() => configuration.resolve(saved, "missing-native-model"))
      .toThrow("pi_native_model_not_found: native-provider/missing-native-model");
  });

  it("keeps pi-native catalog resolution even when a legacy config says generic", () => {
    const template = {
      id: "native-model",
      name: "Native Model",
      api: "anthropic-messages",
      provider: "native-provider",
      baseUrl: "https://native.example/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 3, output: 9, cacheRead: 1, cacheWrite: 2 },
      contextWindow: 200_000,
      maxTokens: 32_000,
    } as Model<Api>;
    const configuration = new ProviderModelConfiguration({
      providers: () => ["native-provider"],
      model: () => template,
    });
    const saved = configuration.normalize({
      id: "native-provider",
      kind: "pi-native",
      modelConfigs: [{
        id: "native-model",
        contextWindow: 64_000,
        inputModalities: ["text"],
        compatibilityMode: "generic",
      }],
    });

    expect(configuration.resolve(saved, "native-model")?.runtimeModel).toMatchObject({
      api: "anthropic-messages",
      provider: "native-provider",
      cost: { input: 3, output: 9, cacheRead: 1, cacheWrite: 2 },
      contextWindow: 64_000,
    });
  });
});
