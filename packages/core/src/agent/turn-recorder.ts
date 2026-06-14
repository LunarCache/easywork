import type { AgentEvent, ContentPart, ToolCall, ToolResult } from "@ew/shared";
import { normalizeContent } from "@ew/shared";

/** 从 AgentEvent 流重建出的、需持久化的一条历史消息（assistant 带工具 / tool 结果）。 */
export interface RecordedMessage {
  role: "assistant" | "tool";
  parts: ContentPart[];
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
}

/**
 * 从 agent loop 的 AgentEvent 流重建带工具的对话轮（对齐 Hermes：完整历史含 tool_calls/results）。
 * 一个带工具的 assistant 轮 = tool-start 前累计的文本 + 该轮的 tool 调用；其后跟随各 tool 结果消息。
 * 无工具的收尾轮不在此重建（由 final 事件的文本单独持久化），避免重复。
 *
 * 用法：每个事件调 push()，返回此刻应追加的消息（多数事件返回 []）。
 */
export class ToolTurnRecorder {
  private curText = "";
  private turnCalls: ToolCall[] = [];
  private turnResults: ToolResult[] = [];
  private inToolPhase = false;

  push(ev: AgentEvent): RecordedMessage[] {
    switch (ev.type) {
      case "text":
        // 工具阶段后再出现文本 → 进入下一轮，先结算上一带工具轮。
        if (this.inToolPhase) {
          const flushed = this.flush();
          this.curText += ev.text;
          return flushed;
        }
        this.curText += ev.text;
        return [];
      case "tool-start":
        this.inToolPhase = true;
        this.turnCalls.push(ev.call);
        return [];
      case "tool-end":
        this.turnResults.push(ev.result);
        return [];
      case "final":
        return this.flush();
      default:
        return [];
    }
  }

  private flush(): RecordedMessage[] {
    if (this.turnCalls.length === 0) {
      this.curText = "";
      this.inToolPhase = false;
      return [];
    }
    const out: RecordedMessage[] = [
      {
        role: "assistant",
        parts: this.curText.trim() ? [{ type: "text", text: this.curText }] : [],
        toolCalls: this.turnCalls.slice(),
      },
      ...this.turnResults.map(
        (r): RecordedMessage => ({
          role: "tool",
          parts: normalizeContent(r.content),
          toolResults: [r],
        }),
      ),
    ];
    this.curText = "";
    this.turnCalls = [];
    this.turnResults = [];
    this.inToolPhase = false;
    return out;
  }
}
