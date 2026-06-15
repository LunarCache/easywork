import { describe, it, expect } from "vitest";
import type { SamplingParams } from "@ew/shared";
import { applySampling } from "../src/agent/session-host.js";

const full: SamplingParams = {
  temperature: 0.6,
  topP: 0.95,
  topK: 20,
  minP: 0.01,
  repeatPenalty: 1.1,
  frequencyPenalty: 0.2,
  presencePenalty: 0.1,
  maxTokens: 1024,
  seed: 7,
};

describe("applySampling", () => {
  it("本地：标准 + llama.cpp 扩展全注入", () => {
    expect(applySampling({ model: "m" }, full, true)).toEqual({
      model: "m",
      temperature: 0.6,
      top_p: 0.95,
      max_tokens: 1024,
      seed: 7,
      frequency_penalty: 0.2,
      presence_penalty: 0.1,
      top_k: 20,
      min_p: 0.01,
      repeat_penalty: 1.1,
    });
  });

  it("云端：只注标准，丢弃 llama 扩展（top_k/min_p/repeat_penalty）", () => {
    const out = applySampling({ model: "m" }, full, false);
    expect(out.top_p).toBe(0.95);
    expect(out.temperature).toBe(0.6);
    expect(out.top_k).toBeUndefined();
    expect(out.min_p).toBeUndefined();
    expect(out.repeat_penalty).toBeUndefined();
  });

  it("只设了的字段才写（不覆盖未提供项）", () => {
    expect(applySampling({ temperature: 9 }, { temperature: 0.3 }, true)).toEqual({ temperature: 0.3 });
    expect(applySampling({ a: 1 }, {}, true)).toEqual({ a: 1 });
  });
});
