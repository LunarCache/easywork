// pi 的 AgentEvent 流 → 我们的 SSE AgentEvent 流（UI/SDK 契约不变）。
import type { AgentEvent as PiAgentEvent } from "@earendil-works/pi-agent-core";
import type { AgentEvent, Usage } from "@ew/shared";

interface PiContent {
  type: string;
  text?: string;
}
function piContentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return (content as PiContent[])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("");
}

function piUsage(u: unknown): Usage | undefined {
  const x = u as { input?: number; output?: number; totalTokens?: number } | undefined;
  if (!x) return undefined;
  return {
    promptTokens: x.input ?? 0,
    completionTokens: x.output ?? 0,
    totalTokens: x.totalTokens ?? (x.input ?? 0) + (x.output ?? 0),
  };
}

/**
 * 有状态映射器：累积最后一条 assistant 文本，在 agent_end 时产出我们的 final 事件。
 * map() 对每个 pi 事件返回 0..n 个我们的 AgentEvent。
 */
export class PiEventMapper {
  private finalText = "";
  private usageEmitted = false;

  map(ev: PiAgentEvent): AgentEvent[] {
    switch (ev.type) {
      case "message_update": {
        const a = ev.assistantMessageEvent;
        if (a.type === "text_delta") return [{ type: "text", text: a.delta }];
        if (a.type === "thinking_delta") return [{ type: "reasoning", text: a.delta }];
        if (a.type === "done") {
          this.finalText = piContentText(a.message.content);
          return this.emitUsage(a.message.usage);
        }
        if (a.type === "error")
          return [{ type: "error", message: a.error.errorMessage ?? "推理出错" }];
        return [];
      }
      case "message_end": {
        const m = ev.message as { role?: string; content?: unknown; usage?: unknown };
        if (m.role === "assistant") {
          const t = piContentText(m.content);
          if (t) this.finalText = t;
          return this.emitUsage(m.usage);
        }
        return [];
      }
      case "tool_execution_start":
        return [
          {
            type: "tool-start",
            call: { id: ev.toolCallId, name: ev.toolName, arguments: JSON.stringify(ev.args ?? {}) },
          },
        ];
      case "tool_execution_update": {
        const pr = ev.partialResult as { content?: unknown; details?: { kind?: string; stream?: string } } | undefined;
        if (pr?.details?.kind === "tool-progress") {
          return [
            {
              type: "tool-progress",
              callId: ev.toolCallId,
              stream: pr.details.stream === "stderr" ? "stderr" : "stdout",
              chunk: piContentText(pr.content),
            },
          ];
        }
        return [];
      }
      case "tool_execution_end": {
        const r = ev.result as { content?: unknown; details?: unknown } | undefined;
        return [
          {
            type: "tool-end",
            call: { id: ev.toolCallId, name: ev.toolName, arguments: "" },
            result: {
              content: piContentText(r?.content),
              isError: ev.isError,
              ...(r?.details != null ? { display: r.details } : {}),
            },
          },
        ];
      }
      case "agent_end":
        return [{ type: "final", message: { role: "assistant", content: this.finalText } }];
      default:
        return [];
    }
  }

  /** 产出 usage 事件（每轮去重一次）。 */
  private emitUsage(u: unknown): AgentEvent[] {
    if (this.usageEmitted) return [];
    const usage = piUsage(u);
    if (!usage) return [];
    this.usageEmitted = true;
    return [{ type: "usage", usage }];
  }
}
