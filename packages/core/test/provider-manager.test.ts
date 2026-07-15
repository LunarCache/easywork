import { describe, expect, it } from "vitest";
import { EngineRegistry } from "../src/engine/registry.js";
import { ProviderModelConfiguration } from "../src/providers/model-configuration.js";
import { ProviderManager } from "../src/providers/manager.js";

describe("ProviderManager", () => {
  it("routes provider models with scoped ids while sending raw model ids upstream", async () => {
    let upstreamModel = "";
    const registry = new EngineRegistry();
    const providers = new ProviderManager(registry, {
      fetch: async (_input, init) => {
        upstreamModel = (JSON.parse(String(init?.body ?? "{}")) as { model?: string }).model ?? "";
        return new Response(JSON.stringify({
          model: upstreamModel,
          choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });

    providers.add({
      id: "custom-deepseek",
      kind: "openai-compatible",
      api: "openai-completions",
      baseUrl: "https://custom.example/v1",
      connections: [{ id: "responses", api: "openai-responses", baseUrl: "https://responses.example/v1" }],
      modelConfigs: [{ id: "deepseek-v4", contextWindow: 32768, inputModalities: ["text"] }],
    });

    const routeId = "provider:custom-deepseek:deepseek-v4";
    expect(providers.modelIds()).toEqual([routeId]);
    expect(providers.list()[0]?.connections).toEqual([
      { id: "responses", api: "openai-responses", baseUrl: "https://responses.example/v1" },
    ]);
    await registry.resolve(routeId).chat({ model: routeId, messages: [{ role: "user", content: "hi" }] });
    expect(upstreamModel).toBe("deepseek-v4");
  });

  it("can list and remove a stale pi-native route without resolving its runtime model", () => {
    const providers = new ProviderManager(new EngineRegistry(), {
      modelConfiguration: new ProviderModelConfiguration({
        providers: () => [],
        model: () => undefined,
      }),
    });
    providers.add({
      id: "native-provider",
      kind: "pi-native",
      modelConfigs: [{
        id: "removed-upstream-model",
        contextWindow: 32_768,
        inputModalities: ["text"],
      }],
    });

    expect(providers.modelIds()).toEqual(["provider:native-provider:removed-upstream-model"]);
    expect(() => providers.remove("native-provider")).not.toThrow();
    expect(providers.dump()).toEqual([]);
  });
});
