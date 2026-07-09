import { describe, expect, it } from "vitest";
import { EngineRegistry } from "../src/engine/registry.js";
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
      modelConfigs: [{ id: "deepseek-v4", contextWindow: 32768, inputModalities: ["text"] }],
    });

    const routeId = "provider:custom-deepseek:deepseek-v4";
    expect(providers.modelIds()).toEqual([routeId]);
    await registry.resolve(routeId).chat({ model: routeId, messages: [{ role: "user", content: "hi" }] });
    expect(upstreamModel).toBe("deepseek-v4");
  });
});
