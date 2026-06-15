import { describe, it, expect } from "vitest";
import { resolvePiModel, type PiModelResolverDeps } from "../src/ai/pi-models.js";

const deps = (over: Partial<PiModelResolverDeps> = {}): PiModelResolverDeps => ({
  localBaseUrl: () => undefined,
  cloudProvider: () => undefined,
  ...over,
});

describe("resolvePiModel", () => {
  it("本地模型 → openai-completions 指向 llama-server，apiKey=local", () => {
    const r = resolvePiModel("/models/Qwen3.gguf", deps({ localBaseUrl: () => "http://127.0.0.1:8971/v1" }));
    expect(r.model.api).toBe("openai-completions");
    expect(r.model.baseUrl).toBe("http://127.0.0.1:8971/v1");
    expect(r.model.provider).toBe("local");
    expect(r.model.name).toBe("Qwen3.gguf"); // 去路径
    expect(r.apiKey).toBe("local");
    expect(r.model.input).toEqual(["text"]);
  });

  it("云端模型 → provider baseUrl + apiKey + headers，去尾斜杠", () => {
    const r = resolvePiModel(
      "gpt-x",
      deps({
        cloudProvider: () => ({
          id: "openrouter",
          baseUrl: "https://api.x.com/v1/",
          apiKey: "sk-1",
          headers: { "x-h": "1" },
        }),
      }),
    );
    expect(r.model.baseUrl).toBe("https://api.x.com/v1");
    expect(r.model.provider).toBe("openrouter");
    expect(r.apiKey).toBe("sk-1");
    expect(r.model.headers).toEqual({ "x-h": "1" });
  });

  it("本地优先于云端", () => {
    const r = resolvePiModel(
      "m",
      deps({
        localBaseUrl: () => "http://127.0.0.1:9/v1",
        cloudProvider: () => ({ id: "c", baseUrl: "https://cloud", apiKey: "k" }),
      }),
    );
    expect(r.model.provider).toBe("local");
  });

  it("vision + contextWindow 注入", () => {
    const r = resolvePiModel(
      "vl",
      deps({
        localBaseUrl: () => "http://127.0.0.1:9/v1",
        vision: () => true,
        contextWindow: () => 32768,
      }),
    );
    expect(r.model.input).toEqual(["text", "image"]);
    expect(r.model.contextWindow).toBe(32768);
    expect(r.model.maxTokens).toBe(4096); // min(4096, ctx/2)
  });

  it("无法解析 → 抛错", () => {
    expect(() => resolvePiModel("nope", deps())).toThrow(/无法解析模型/);
  });
});
