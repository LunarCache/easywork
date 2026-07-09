import { describe, expect, it } from "vitest";
import { ProviderCatalog } from "../src/providers/catalog.js";

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
      sampleModels: ["gpt-test"],
      models: [{
        id: "gpt-test",
        contextWindow: 128000,
        inputModalities: ["text", "image"],
      }],
    });
    expect(providers[2]?.label).toBe("Custom Provider");
    expect(providers[2]?.models[0]?.inputModalities).toEqual(["text", "image"]);
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
});
