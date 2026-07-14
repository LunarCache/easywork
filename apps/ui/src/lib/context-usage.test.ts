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
    expect(
      composerUsageState({ promptTokens: 8192, completionTokens: 512, totalTokens: 8704 }, 32768),
    ).toEqual({
      pct: 26.5625,
      title: "上下文已用 26.6% · 8,704/32,768 tokens",
      parts: [
        { key: "unclassified", label: "其余输入（系统等）", tokens: 8192, pct: 25, estimated: true },
        { key: "output", label: "本轮输出", tokens: 512, pct: 1.5625 },
        { key: "available", label: "可用空间", tokens: 24064, pct: 73.4375 },
      ],
    });
  });

  it("keeps provider-only usage overhead visible in the distribution", () => {
    expect(
      composerUsageState({ promptTokens: 8000, completionTokens: 500, totalTokens: 9000 }, 10000),
    ).toEqual({
      pct: 90,
      title: "上下文已用 90% · 9,000/10,000 tokens",
      parts: [
        { key: "unclassified", label: "其余输入（系统等）", tokens: 8000, pct: 80, estimated: true },
        { key: "output", label: "本轮输出", tokens: 500, pct: 5 },
        { key: "other", label: "其他开销", tokens: 500, pct: 5 },
        { key: "available", label: "可用空间", tokens: 1000, pct: 10 },
      ],
    });
  });

  it("estimates the input content split without changing the measured total", () => {
    const messages = [
      { role: "user" as const, raw: "u".repeat(40), reasoning: "", tools: [] },
      { role: "assistant" as const, raw: "a".repeat(19), reasoning: "", tools: [] },
      { role: "user" as const, raw: "u".repeat(20), reasoning: "", tools: [] },
      { role: "assistant" as const, raw: "current output is excluded", reasoning: "", tools: [] },
    ];

    expect(composerUsageState({ promptTokens: 100, completionTokens: 20, totalTokens: 120 }, 200, messages)).toEqual({
      pct: 60,
      title: "上下文已用 60% · 120/200 tokens",
      parts: [
        { key: "unclassified", label: "其余输入（系统等）", tokens: 80, pct: 40, estimated: true },
        { key: "user", label: "用户消息", tokens: 15, pct: 7.5, estimated: true },
        { key: "assistant", label: "助手历史", tokens: 5, pct: 2.5, estimated: true },
        { key: "output", label: "本轮输出", tokens: 20, pct: 10 },
        { key: "available", label: "可用空间", tokens: 80, pct: 40 },
      ],
    });
  });
});
