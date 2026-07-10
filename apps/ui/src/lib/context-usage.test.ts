import { describe, expect, it } from "vitest";
import { composerUsageState } from "./context-usage.js";

describe("composerUsageState", () => {
  it("does not invent 0% when usage is unknown", () => {
    expect(composerUsageState(null, 32768)).toEqual({
      pct: null,
      title: "上下文窗口 32768 tokens",
    });
  });

  it("computes context usage from the last known prompt token count", () => {
    expect(composerUsageState({ promptTokens: 8192, completionTokens: 512, totalTokens: 8704 }, 32768)).toEqual({
      pct: 25,
      title: "上下文已用 25% · 8192/32768 tokens",
    });
  });
});
