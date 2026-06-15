import { describe, it, expect } from "vitest";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { mapSessionEvent } from "../src/agent/session-host.js";

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
      toolName: "web_search",
      isError: false,
      result: {
        content: [{ type: "text", text: "结果" }],
        details: [{ title: "T", url: "https://x" }],
      },
    } as unknown as AgentSessionEvent;
    expect(mapSessionEvent(ev)).toEqual([
      {
        type: "tool-end",
        call: { id: "c1", name: "web_search", arguments: "" },
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
    expect(mapSessionEvent({ type: "compaction_start", reason: "threshold" } as AgentSessionEvent)).toEqual([]);
    expect(mapSessionEvent({ type: "agent_start" } as AgentSessionEvent)).toEqual([]);
  });
});
