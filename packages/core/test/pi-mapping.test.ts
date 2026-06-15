import { describe, it, expect } from "vitest";
import type { AgentEvent as PiAgentEvent } from "@earendil-works/pi-agent-core";
import { ewHistoryToPi } from "../src/agent/pi/message-map.js";
import { PiEventMapper } from "../src/agent/pi/event-map.js";

describe("ewHistoryToPi", () => {
  it("system 折叠进 systemPrompt；user/assistant/tool 转 pi Message", () => {
    const { systemPrompt, messages } = ewHistoryToPi(
      [
        { role: "system", content: "你是助手" },
        { role: "system", content: "用中文" },
        { role: "user", content: "你好" },
        { role: "assistant", content: "在", toolCalls: [{ id: "c1", name: "f", arguments: '{"a":1}' }] },
        { role: "tool", toolCallId: "c1", content: "结果" },
      ],
      "qwen3",
    );
    expect(systemPrompt).toBe("你是助手\n\n用中文");
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult"]);
    const a = messages[1] as { content: { type: string; name?: string }[]; model: string };
    expect(a.model).toBe("qwen3");
    expect(a.content.some((c) => c.type === "toolCall" && c.name === "f")).toBe(true);
    const tr = messages[2] as { toolCallId: string };
    expect(tr.toolCallId).toBe("c1");
  });
});

describe("PiEventMapper", () => {
  const m = () => new PiEventMapper();
  it("text_delta / thinking_delta → text / reasoning", () => {
    const map = m();
    expect(map.map({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi", partial: {} } } as unknown as PiAgentEvent)).toEqual([{ type: "text", text: "hi" }]);
    expect(map.map({ type: "message_update", message: {}, assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "嗯", partial: {} } } as unknown as PiAgentEvent)).toEqual([{ type: "reasoning", text: "嗯" }]);
  });

  it("tool_execution_start/update/end → tool-start/progress/end", () => {
    const map = m();
    expect(map.map({ type: "tool_execution_start", toolCallId: "c1", toolName: "run_command", args: { command: "ls" } } as PiAgentEvent)).toEqual([
      { type: "tool-start", call: { id: "c1", name: "run_command", arguments: '{"command":"ls"}' } },
    ]);
    expect(map.map({ type: "tool_execution_update", toolCallId: "c1", toolName: "run_command", args: {}, partialResult: { content: [{ type: "text", text: "out\n" }], details: { kind: "tool-progress", stream: "stdout" } } } as unknown as PiAgentEvent)).toEqual([
      { type: "tool-progress", callId: "c1", stream: "stdout", chunk: "out\n" },
    ]);
    expect(map.map({ type: "tool_execution_end", toolCallId: "c1", toolName: "run_command", result: { content: [{ type: "text", text: "[exit 0]" }], details: { kind: "exec" } }, isError: false } as unknown as PiAgentEvent)).toEqual([
      { type: "tool-end", call: { id: "c1", name: "run_command", arguments: "" }, result: { content: "[exit 0]", isError: false, display: { kind: "exec" } } },
    ]);
  });

  it("done → usage；message_end + agent_end → final（带累积文本）", () => {
    const map = m();
    const u = map.map({ type: "message_update", message: {}, assistantMessageEvent: { type: "done", reason: "stop", message: { content: [{ type: "text", text: "答案" }], usage: { input: 10, output: 5, totalTokens: 15 } } } } as unknown as PiAgentEvent);
    expect(u).toEqual([{ type: "usage", usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }]);
    map.map({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "答案" }] } } as unknown as PiAgentEvent);
    expect(map.map({ type: "agent_end", messages: [] } as unknown as PiAgentEvent)).toEqual([{ type: "final", message: { role: "assistant", content: "答案" } }]);
  });

  it("error 事件 → error", () => {
    expect(m().map({ type: "message_update", message: {}, assistantMessageEvent: { type: "error", reason: "error", error: { errorMessage: "boom" } } } as unknown as PiAgentEvent)).toEqual([{ type: "error", message: "boom" }]);
  });
});
