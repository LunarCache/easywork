import { describe, it, expect } from "vitest";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { mapSessionEvent, injectLocalThinking, injectCloudThinking } from "../src/agent/session-host.js";

// R1：pi AgentSessionEvent → 我们的 AgentEvent 的边界翻译，逐型锁定。
describe("mapSessionEvent", () => {
  it("text_delta → text", () => {
    const ev = {
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "你好", partial: {} },
    } as unknown as AgentSessionEvent;
    expect(mapSessionEvent(ev)).toEqual([{ type: "text", text: "你好" }]);
  });

  it("thinking_delta → reasoning", () => {
    const ev = {
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "想…", partial: {} },
    } as unknown as AgentSessionEvent;
    expect(mapSessionEvent(ev)).toEqual([{ type: "reasoning", text: "想…" }]);
  });

  it("non-delta assistant events are dropped", () => {
    const ev = {
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: {} },
    } as unknown as AgentSessionEvent;
    expect(mapSessionEvent(ev)).toEqual([]);
  });

  it("assistant error event → error", () => {
    const ev = {
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "error", reason: "error", error: { errorMessage: "boom" } },
    } as unknown as AgentSessionEvent;
    expect(mapSessionEvent(ev)).toEqual([{ type: "error", message: "boom" }]);
  });

  it("tool_execution_start → tool-start with stringified args", () => {
    const ev = {
      type: "tool_execution_start",
      toolCallId: "c1",
      toolName: "read",
      args: { path: "README.md" },
    } as unknown as AgentSessionEvent;
    expect(mapSessionEvent(ev)).toEqual([
      { type: "tool-start", call: { id: "c1", name: "read", arguments: '{"path":"README.md"}' } },
    ]);
  });

  it("tool_execution_end → tool-end, content flattened from pi result", () => {
    const ev = {
      type: "tool_execution_end",
      toolCallId: "c1",
      toolName: "read",
      isError: false,
      result: { content: [{ type: "text", text: "file body" }, { type: "image", data: "x", mimeType: "image/png" }] },
    } as unknown as AgentSessionEvent;
    expect(mapSessionEvent(ev)).toEqual([
      { type: "tool-end", call: { id: "c1", name: "read", arguments: "" }, result: { content: "file body", isError: false } },
    ]);
  });

  it("tool_execution_end → 透传 display（pi details，供 UI 渲染来源/引用/工件）", () => {
    const ev = {
      type: "tool_execution_end",
      toolCallId: "c1",
      toolName: "explore_web",
      isError: false,
      result: {
        content: [{ type: "text", text: "结果" }],
        details: [{ title: "T", url: "https://x" }],
      },
    } as unknown as AgentSessionEvent;
    expect(mapSessionEvent(ev)).toEqual([
      {
        type: "tool-end",
        call: { id: "c1", name: "explore_web", arguments: "" },
        result: { content: "结果", isError: false, display: [{ title: "T", url: "https://x" }] },
      },
    ]);
  });

  it("message_end (assistant) → usage", () => {
    const ev = {
      type: "message_end",
      message: { role: "assistant", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: {} } },
    } as unknown as AgentSessionEvent;
    expect(mapSessionEvent(ev)).toEqual([
      { type: "usage", usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
    ]);
  });

  it("agent_end → final with last assistant text", () => {
    const ev = {
      type: "agent_end",
      willRetry: false,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "text", text: "答案" }, { type: "toolCall", id: "t", name: "x", arguments: {} }] },
      ],
    } as unknown as AgentSessionEvent;
    expect(mapSessionEvent(ev)).toEqual([{ type: "final", message: { role: "assistant", content: "答案" } }]);
  });

  it("unmapped session events → empty", () => {
    expect(mapSessionEvent({ type: "queue_update", steering: [], followUp: [] } as unknown as AgentSessionEvent)).toEqual([]);
    expect(mapSessionEvent({ type: "agent_start" } as AgentSessionEvent)).toEqual([]);
  });

  it("auto_retry_start → retry 事件", () => {
    const ev = { type: "auto_retry_start", attempt: 2, maxAttempts: 5, delayMs: 1000, errorMessage: "429" } as AgentSessionEvent;
    expect(mapSessionEvent(ev)).toEqual([{ type: "retry", attempt: 2, maxAttempts: 5, delayMs: 1000, message: "429" }]);
  });

  it("compaction_start/end → compaction 事件（end 带 ok + token 增减）", () => {
    expect(mapSessionEvent({ type: "compaction_start", reason: "threshold" } as AgentSessionEvent)).toEqual([
      { type: "compaction", phase: "start", reason: "threshold" },
    ]);
    const ok = {
      type: "compaction_end",
      reason: "manual",
      aborted: false,
      willRetry: false,
      result: { summary: "s", firstKeptEntryId: "e", tokensBefore: 8000, estimatedTokensAfter: 1200 },
    } as unknown as AgentSessionEvent;
    expect(mapSessionEvent(ok)).toEqual([
      { type: "compaction", phase: "end", reason: "manual", ok: true, tokensBefore: 8000, tokensAfter: 1200 },
    ]);
    // 中止/失败的压缩不能谎报成功：ok=false。
    const failed = { type: "compaction_end", reason: "overflow", aborted: true, willRetry: false, result: undefined } as unknown as AgentSessionEvent;
    expect(mapSessionEvent(failed)).toEqual([{ type: "compaction", phase: "end", reason: "overflow", ok: false }]);
  });

  it("agent_end{willRetry} 不发 final（重试/压缩续写在即）", () => {
    const retrying = { type: "agent_end", willRetry: true, messages: [] } as unknown as AgentSessionEvent;
    expect(mapSessionEvent(retrying)).toEqual([]);
  });

  it("agent_end 末条 assistant stopReason=error → 冒泡 error（不吞成空 final）", () => {
    const ev = {
      type: "agent_end",
      willRetry: false,
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: [], stopReason: "error", errorMessage: "400 Invalid schema" },
      ],
    } as unknown as AgentSessionEvent;
    expect(mapSessionEvent(ev)).toEqual([{ type: "error", message: "400 Invalid schema" }]);
  });
});

describe("injectLocalThinking", () => {
  it("off → enable_thinking=false + budget 0", () => {
    expect(injectLocalThinking({}, "off")).toEqual({
      chat_template_kwargs: { enable_thinking: false },
      thinking_budget_tokens: 0,
    });
  });
  it("分级 → enable_thinking=true + 对应预算，保留已有 kwargs", () => {
    const out = injectLocalThinking({ messages: [], chat_template_kwargs: { foo: 1 } }, "medium");
    expect(out.chat_template_kwargs).toEqual({ foo: 1, enable_thinking: true });
    expect(out.thinking_budget_tokens).toBe(4096);
    expect(out.messages).toEqual([]); // 不破坏其余请求体
  });
});

describe("injectCloudThinking", () => {
  it("off → thinking:disabled（真关，省 reasoning token）", () => {
    expect(injectCloudThinking({ messages: [] }, "off")).toEqual({ messages: [], thinking: { type: "disabled" } });
  });
  it("分级 → thinking:enabled + reasoning_effort=档位", () => {
    expect(injectCloudThinking({ messages: [] }, "high")).toEqual({
      messages: [],
      thinking: { type: "enabled" },
      reasoning_effort: "high",
    });
  });
});
