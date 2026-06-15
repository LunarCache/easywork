import { describe, it, expect } from "vitest";
import type { AgentEvent } from "@ew/shared";
import { ToolTurnRecorder, type RecordedMessage } from "../src/agent/turn-recorder.js";

function replay(events: AgentEvent[]): RecordedMessage[] {
  const rec = new ToolTurnRecorder();
  const out: RecordedMessage[] = [];
  for (const e of events) out.push(...rec.push(e));
  return out;
}

const call = (id: string, name: string, args = "{}") => ({ id, name, arguments: args });

describe("ToolTurnRecorder", () => {
  it("无工具：只有 final → 不重建任何带工具轮（final 文本由调用方单独持久化）", () => {
    const msgs = replay([
      { type: "text", text: "你好" },
      { type: "final", message: { role: "assistant", content: "你好" } },
    ]);
    expect(msgs).toEqual([]);
  });

  it("单轮工具：assistant(带 toolCalls) + tool 结果", () => {
    const msgs = replay([
      { type: "text", text: "我查一下" },
      { type: "tool-start", call: call("c1", "calc", '{"expr":"1+1"}') },
      { type: "tool-end", call: call("c1", "calc", '{"expr":"1+1"}'), result: { content: "2" } },
      { type: "text", text: "答案是 2" },
      { type: "final", message: { role: "assistant", content: "答案是 2" } },
    ]);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({
      role: "assistant",
      parts: [{ type: "text", text: "我查一下" }],
      toolCalls: [{ id: "c1", name: "calc" }],
    });
    expect(msgs[1]).toMatchObject({
      role: "tool",
      parts: [{ type: "text", text: "2" }],
      toolResults: [{ content: "2" }],
    });
  });

  it("多轮工具：每轮在下一轮文本到来时结算", () => {
    const msgs = replay([
      { type: "tool-start", call: call("c1", "a") },
      { type: "tool-end", call: call("c1", "a"), result: { content: "ra" } },
      { type: "text", text: "继续" },
      { type: "tool-start", call: call("c2", "b") },
      { type: "tool-end", call: call("c2", "b"), result: { content: "rb" } },
      { type: "final", message: { role: "assistant", content: "好了" } },
    ]);
    // 轮1: assistant(a)+tool(ra); 轮2: assistant("继续"+b)+tool(rb)
    expect(msgs.map((m) => m.role)).toEqual(["assistant", "tool", "assistant", "tool"]);
    expect(msgs[0]!.parts).toEqual([]); // 轮1 无文本
    expect(msgs[0]!.toolCalls?.[0]!.name).toBe("a");
    expect(msgs[2]!.parts).toEqual([{ type: "text", text: "继续" }]);
    expect(msgs[2]!.toolCalls?.[0]!.name).toBe("b");
  });

  it("一轮多个工具调用：一条 assistant + 多条 tool 结果", () => {
    const msgs = replay([
      { type: "tool-start", call: call("c1", "a") },
      { type: "tool-end", call: call("c1", "a"), result: { content: "ra" } },
      { type: "tool-start", call: call("c2", "b") },
      { type: "tool-end", call: call("c2", "b"), result: { content: "rb" } },
      { type: "final", message: { role: "assistant", content: "" } },
    ]);
    expect(msgs.map((m) => m.role)).toEqual(["assistant", "tool", "tool"]);
    expect(msgs[0]!.toolCalls).toHaveLength(2);
  });
});
