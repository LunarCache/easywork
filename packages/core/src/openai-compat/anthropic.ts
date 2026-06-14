import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ChatStreamEvent,
  ContentPart,
  FinishReason,
  ToolDefinition,
} from "@ew/shared";

/** Anthropic Messages API ↔ 内部 ChatRequest 翻译，复用同一引擎/agent loop。 */

interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  tool_use_id?: string;
  source?: { type: string; media_type?: string; data?: string };
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicBlock[];
}

export interface AnthropicRequestBody {
  model?: string;
  system?: string | AnthropicBlock[];
  messages?: AnthropicMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  stream?: boolean;
  tools?: { name: string; description?: string; input_schema?: Record<string, unknown> }[];
}

function systemText(system: AnthropicRequestBody["system"]): string {
  if (!system) return "";
  if (typeof system === "string") return system;
  return system.map((b) => b.text ?? "").join("\n");
}

/** Anthropic 请求 → 内部 ChatRequest。 */
export function anthropicToChatRequest(body: AnthropicRequestBody): ChatRequest {
  const messages: ChatMessage[] = [];
  const sys = systemText(body.system);
  if (sys) messages.push({ role: "system", content: sys });

  for (const m of body.messages ?? []) {
    if (typeof m.content === "string") {
      messages.push({ role: m.role, content: m.content });
      continue;
    }
    // 数组内容：拆出 text / image / tool_use（assistant）/ tool_result（→ tool 角色消息）。
    const parts: ContentPart[] = [];
    const toolCalls: { id: string; name: string; arguments: string }[] = [];
    const toolResults: { toolCallId: string; content: string }[] = [];
    for (const b of m.content) {
      if (b.type === "text" && b.text != null) parts.push({ type: "text", text: b.text });
      else if (b.type === "image" && b.source?.data) {
        parts.push({
          type: "image",
          mimeType: b.source.media_type ?? "image/png",
          data: b.source.data,
        });
      } else if (b.type === "tool_use" && b.id && b.name) {
        toolCalls.push({ id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) });
      } else if (b.type === "tool_result" && b.tool_use_id) {
        const c = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
        toolResults.push({ toolCallId: b.tool_use_id, content: c });
      }
    }
    // tool_result 块 → 独立的 tool 角色消息（OpenAI 形态）。
    for (const tr of toolResults) {
      messages.push({ role: "tool", toolCallId: tr.toolCallId, content: tr.content });
    }
    if (parts.length > 0 || toolCalls.length > 0) {
      messages.push({
        role: m.role,
        content: parts.length === 1 && parts[0]!.type === "text" ? parts[0]!.text : parts,
        ...(toolCalls.length ? { toolCalls } : {}),
      });
    }
  }

  const tools: ToolDefinition[] | undefined = body.tools?.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    parameters: t.input_schema ?? { type: "object", properties: {} },
  }));

  return {
    model: body.model ?? "",
    messages,
    ...(tools && tools.length ? { tools, toolChoice: "auto" as const } : {}),
    ...(body.max_tokens != null ? { maxTokens: body.max_tokens } : {}),
    ...(body.temperature != null ? { temperature: body.temperature } : {}),
    ...(body.top_p != null ? { topP: body.top_p } : {}),
    ...(body.top_k != null ? { topK: body.top_k } : {}),
    ...(body.stop_sequences ? { stop: body.stop_sequences } : {}),
  };
}

function stopReason(fr: FinishReason | undefined): string {
  switch (fr) {
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    default:
      return "end_turn";
  }
}

/** 内部 ChatResponse → Anthropic 非流式 message。 */
export function chatResponseToAnthropic(res: ChatResponse, id: string, model: string): unknown {
  const content: AnthropicBlock[] = [];
  const text = typeof res.message.content === "string" ? res.message.content : "";
  if (text) content.push({ type: "text", text });
  for (const tc of res.message.toolCalls ?? []) {
    let input: unknown = {};
    try {
      input = JSON.parse(tc.arguments || "{}");
    } catch {
      input = {};
    }
    content.push({ type: "tool_use", id: tc.id, name: tc.name, input });
  }
  return {
    id,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stopReason(res.finishReason),
    stop_sequence: null,
    usage: {
      input_tokens: res.usage?.promptTokens ?? 0,
      output_tokens: res.usage?.completionTokens ?? 0,
    },
  };
}

/** 流式翻译器：把内部 ChatStreamEvent 序列翻译为 Anthropic SSE 帧。 */
export class AnthropicStreamTranslator {
  private blockIndex = -1;
  private textOpen = false;
  private toolOpen = false;
  private outputTokens = 0;
  private finish: FinishReason = "stop";

  constructor(
    private readonly id: string,
    private readonly model: string,
  ) {}

  private frame(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  start(): string {
    return this.frame("message_start", {
      type: "message_start",
      message: {
        id: this.id,
        type: "message",
        role: "assistant",
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  private closeOpenBlock(): string {
    if (this.textOpen || this.toolOpen) {
      this.textOpen = false;
      this.toolOpen = false;
      return this.frame("content_block_stop", { type: "content_block_stop", index: this.blockIndex });
    }
    return "";
  }

  event(ev: ChatStreamEvent): string {
    switch (ev.type) {
      case "text-delta": {
        let out = "";
        if (!this.textOpen) {
          out += this.closeOpenBlock();
          this.blockIndex += 1;
          this.textOpen = true;
          out += this.frame("content_block_start", {
            type: "content_block_start",
            index: this.blockIndex,
            content_block: { type: "text", text: "" },
          });
        }
        out += this.frame("content_block_delta", {
          type: "content_block_delta",
          index: this.blockIndex,
          delta: { type: "text_delta", text: ev.text },
        });
        return out;
      }
      case "tool-call-start": {
        let out = this.closeOpenBlock();
        this.blockIndex += 1;
        this.toolOpen = true;
        this.finish = "tool_calls";
        out += this.frame("content_block_start", {
          type: "content_block_start",
          index: this.blockIndex,
          content_block: { type: "tool_use", id: ev.id, name: ev.name, input: {} },
        });
        return out;
      }
      case "tool-call-args-delta": {
        if (!this.toolOpen) return "";
        return this.frame("content_block_delta", {
          type: "content_block_delta",
          index: this.blockIndex,
          delta: { type: "input_json_delta", partial_json: ev.delta },
        });
      }
      case "tool-call-end": {
        return this.closeOpenBlock();
      }
      case "usage": {
        this.outputTokens = ev.usage.completionTokens ?? this.outputTokens;
        return "";
      }
      case "done": {
        this.finish = ev.finishReason ?? this.finish;
        return "";
      }
      default:
        return "";
    }
  }

  end(): string {
    let out = this.closeOpenBlock();
    out += this.frame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason(this.finish), stop_sequence: null },
      usage: { output_tokens: this.outputTokens },
    });
    out += this.frame("message_stop", { type: "message_stop" });
    return out;
  }
}
