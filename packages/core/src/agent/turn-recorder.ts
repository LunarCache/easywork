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
  // 本轮累计的内容片段，按发生顺序保留 reasoning/text 交织（思考→文本→工具）。
  private curParts: ContentPart[] = [];
  private turnCalls: ToolCall[] = [];
  private turnResults: ToolResult[] = [];
  private inToolPhase = false;

  push(ev: AgentEvent): RecordedMessage[] {
    switch (ev.type) {
      case "text":
        // 工具阶段后再出现文本 → 进入下一轮，先结算上一带工具轮。
        if (this.inToolPhase) {
          const flushed = this.flush();
          this.appendText(ev.text);
          return flushed;
        }
        this.appendText(ev.text);
        return [];
      case "reasoning":
        // 与 text 同样处理阶段切换：工具后再思考 = 下一轮。
        if (this.inToolPhase) {
          const flushed = this.flush();
          this.appendReasoning(ev.text);
          return flushed;
        }
        this.appendReasoning(ev.text);
        return [];
      case "tool-start":
        this.inToolPhase = true;
        this.turnCalls.push(ev.call);
        return [];
      case "tool-end":
        this.turnResults.push(ev.result);
        return [];
      case "final":
        // 收尾的无工具轮不在此重建（其文本由 final 单独持久化）；只结算带工具轮。
        return this.turnCalls.length > 0 ? this.flush() : [];
      default:
        return [];
    }
  }

  /** 收尾无工具轮残留的思考文本（reasoning part 拼接）—— 供调用方拼到 final 消息。 */
  trailingReasoning(): string {
    return this.curParts
      .filter((p): p is Extract<ContentPart, { type: "reasoning" }> => p.type === "reasoning")
      .map((p) => p.text)
      .join("");
  }

  private appendText(text: string): void {
    const last = this.curParts[this.curParts.length - 1];
    if (last && last.type === "text") last.text += text;
    else this.curParts.push({ type: "text", text });
  }

  private appendReasoning(text: string): void {
    const last = this.curParts[this.curParts.length - 1];
    if (last && last.type === "reasoning") last.text += text;
    else this.curParts.push({ type: "reasoning", text });
  }

  private flush(): RecordedMessage[] {
    if (this.turnCalls.length === 0) {
      this.curParts = [];
      this.inToolPhase = false;
      return [];
    }
    // 保留非空 reasoning/text（按序），丢弃纯空白文本。curParts 只含 text/reasoning。
    const parts = this.curParts.filter((p) => {
      if (p.type === "text") return p.text.trim().length > 0;
      if (p.type === "reasoning") return p.text.trim().length > 0;
      return true;
    });
    const out: RecordedMessage[] = [
      {
        role: "assistant",
        parts,
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
    this.curParts = [];
    this.turnCalls = [];
    this.turnResults = [];
    this.inToolPhase = false;
    return out;
  }
}
