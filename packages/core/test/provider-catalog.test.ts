import { describe, expect, it } from "vitest";
import {
  ProviderCatalog,
  normalizeProviderConfig,
  runtimeModelForProviderConfig,
  runtimeModelsForProviderConfig,
} from "../src/providers/catalog.js";

describe("ProviderCatalog", () => {
  it("builds a sorted built-in provider catalog from pi model metadata", () => {
    const catalog = new ProviderCatalog({
      getPiProviders: () => ["custom-provider", "anthropic", "openai"],
      getPiModels: (provider) => {
        if (provider === "openai") {
          return [{
            id: "gpt-test",
            name: "GPT Test",
            api: "openai-responses",
            contextWindow: 128000,
            input: ["text", "image"],
          }];
        }
        if (provider === "anthropic") {
          return [{
            id: "claude-test",
            name: "Claude Test",
            api: "anthropic-messages",
            contextWindow: 200000,
            input: ["text"],
          }];
        }
        return [{
          id: "custom-test",
          name: "Custom Test",
          api: "openai-completions",
          contextWindow: 32768,
          input: ["image"],
        }];
      },
    });

    const providers = catalog.builtInProviders();

    expect(providers.map((provider) => provider.id)).toEqual(["openai", "anthropic", "custom-provider"]);
    expect(providers[0]).toMatchObject({
	      id: "openai",
	      label: "OpenAI",
	      apiFamilies: ["openai-responses"],
	      apiOptions: [{ id: "openai-responses", label: "OpenAI Responses" }],
	      sampleModels: ["gpt-test"],
      models: [{
        id: "gpt-test",
        contextWindow: 128000,
        inputModalities: ["text", "image"],
      }],
    });
    expect(providers[2]?.label).toBe("Custom Provider");
    expect(providers[2]?.models[0]?.inputModalities).toEqual(["text", "image"]);
    expect(catalog.info().apiFamilies).toContainEqual({
      id: "openai-completions",
      label: "OpenAI Chat Completions",
    });
  });

  it("probes compatible providers with /models fallback and normalizes model metadata", async () => {
    const calls: string[] = [];
    const catalog = new ProviderCatalog({
      fetchImpl: async (input, init) => {
        calls.push(String(input));
        expect((init?.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
        if (String(input) === "https://api.example.test/models") {
          return new Response("not found", { status: 404, statusText: "Not Found" });
        }
        return new Response(JSON.stringify({
          data: [
            { id: "model-a", context_length: "131072", input_modalities: ["text", "image"] },
            { id: "model-b" },
            { id: "model-a", context_length: 32768 },
          ],
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });

    const result = await catalog.probeCompatibleModels({ baseUrl: "https://api.example.test", apiKey: "sk-test" });

    expect(calls).toEqual(["https://api.example.test/models", "https://api.example.test/v1/models"]);
    expect(result.models).toEqual(["model-a", "model-b"]);
    expect(result.modelConfigs).toEqual([
      { id: "model-a", contextWindow: 131072, inputModalities: ["text", "image"] },
      { id: "model-b", contextWindow: 32768, inputModalities: ["text"] },
    ]);
  });

  it("uses a /v1 base URL directly without probing a duplicate fallback URL", async () => {
    const calls: string[] = [];
    const catalog = new ProviderCatalog({
      fetchImpl: async (input) => {
        calls.push(String(input));
        return new Response(JSON.stringify(["model-a"]), { status: 200 });
      },
    });

    await expect(catalog.probeCompatibleModels({ baseUrl: "https://api.example.test/v1" }))
      .resolves.toMatchObject({ models: ["model-a"] });
    expect(calls).toEqual(["https://api.example.test/v1/models"]);
  });

  it("normalizes provider configs and projects runtime model metadata", () => {
    const cfg = normalizeProviderConfig({
      id: "custom",
      baseUrl: "https://api.example.test/v1/",
      headers: { "x-provider": "custom" },
      modelConfigs: [
        {
          id: " model-a ",
          contextWindow: 131072.9,
          inputModalities: ["image"],
          reasoning: true,
          catalogRef: { providerId: "deepseek", modelId: "deepseek-v4-flash" },
        },
        { id: "model-b", contextWindow: 0, inputModalities: ["text"] },
        { id: "model-a", contextWindow: 32768, inputModalities: ["text"] },
      ],
    });

    expect(cfg.baseUrl).toBe("https://api.example.test/v1");
    expect(cfg.modelConfigs).toEqual([
      { id: "model-a", contextWindow: 32768, inputModalities: ["text"] },
    ]);
    expect(runtimeModelForProviderConfig(cfg, "model-a")).toMatchObject({
      id: "model-a",
      input: ["text"],
      contextWindow: 32768,
      headers: { "x-provider": "custom" },
    });
    expect(runtimeModelsForProviderConfig(cfg)).toHaveLength(1);
  });

  it("inherits pi model behavior for custom endpoints without changing their model identity", () => {
    const cfg = normalizeProviderConfig({
      id: "cloudprime",
      kind: "openai-compatible",
      api: "openai-completions",
      baseUrl: "https://cloudprime.example/v1",
      modelConfigs: [{
        id: "deepseek-v4-flash",
        contextWindow: 977000,
        inputModalities: ["text"],
        catalogRef: { providerId: "deepseek", modelId: "deepseek-v4-flash" },
      }],
    });

    expect(runtimeModelForProviderConfig(cfg, "deepseek-v4-flash")).toMatchObject({
      id: "deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      reasoning: true,
      contextWindow: 977000,
      maxTokens: 384000,
      compat: {
        requiresReasoningContentOnAssistantMessages: true,
        thinkingFormat: "deepseek",
      },
      thinkingLevelMap: {
        high: "high",
        xhigh: "max",
      },
    });
  });

  it("supports explicit generic mode and reasoning overrides independently", () => {
    const generic = normalizeProviderConfig({
      id: "custom",
      kind: "openai-compatible",
      api: "openai-completions",
      baseUrl: "https://custom.example/v1",
      modelConfigs: [{
        id: "aliased-model",
        contextWindow: 32768,
        inputModalities: ["text"],
        reasoning: false,
        compatibilityMode: "generic",
        catalogRef: { providerId: "deepseek", modelId: "deepseek-v4-flash" },
      }],
    });

    expect(runtimeModelForProviderConfig(generic, "aliased-model")).toMatchObject({
      id: "aliased-model",
      name: "aliased-model",
      reasoning: false,
      maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    expect(runtimeModelForProviderConfig(generic, "aliased-model").compat).toBeUndefined();

    const catalogAlias = normalizeProviderConfig({
      id: "custom",
      kind: "openai-compatible",
      api: "openai-completions",
      baseUrl: "https://custom.example/v1",
      modelConfigs: [{
        id: "provider-specific-alias",
        contextWindow: 64000,
        inputModalities: ["text"],
        compatibilityMode: "catalog",
        catalogRef: { providerId: "deepseek", modelId: "deepseek-v4-pro" },
      }],
    });

    expect(runtimeModelForProviderConfig(catalogAlias, "provider-specific-alias")).toMatchObject({
      id: "provider-specific-alias",
      name: "DeepSeek V4 Pro",
      reasoning: true,
      contextWindow: 64000,
      compat: {
        requiresReasoningContentOnAssistantMessages: true,
        thinkingFormat: "deepseek",
      },
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
  });
});
