// Step 2：/v1 云端走 pi-ai。这里只做协议适配——把我们的 ChatRequest 转成 pi Context，
// 并把 pi 的 AssistantMessageEvent 流映射回我们的 ChatStreamEvent，从而复用既有的
// streamEventToOpenAIChunks / AnthropicStreamTranslator（一份输入流 → 两种协议输出）。
import { Type } from "typebox";
import type {
  Context as PiContext,
  Message as PiMessage,
  TextContent,
  ImageContent,
  ToolCall as PiToolCall,
  AssistantMessage as PiAssistantMessage,
  AssistantMessageEvent,
} from "@earendil-works/pi-ai";
import type { ChatMessage, ChatRequest, ChatResponse, ChatStreamEvent, ContentPart, FinishReason } from "@ew/shared";
import { messageText } from "@ew/shared";

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** 我们的 content（string | ContentPart[]）→ pi 输入内容（string | (Text|Image)[]）。 */
function toPiInputContent(content: string | ContentPart[]): string | (TextContent | ImageContent)[] {
  if (typeof content === "string") return content;
  const out: (TextContent | ImageContent)[] = [];
  for (const p of content) {
    if (p.type === "text") out.push({ type: "text", text: p.text });
    else if (p.type === "image" && typeof p.data === "string") out.push({ type: "image", data: p.data, mimeType: p.mimeType });
  }
  return out.length ? out : "";
}

/** 我们的 ChatRequest → pi Context（systemPrompt + messages + tools）。 */
export function chatRequestToPiContext(req: ChatRequest): PiContext {
  const system = req.messages
    .filter((m) => m.role === "system")
    .map((m) => messageText(m.content))
    .filter(Boolean)
    .join("\n\n");

  const messages: PiMessage[] = [];
  for (const m of req.messages) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      messages.push({ role: "user", content: toPiInputContent(m.content), timestamp: 0 });
    } else if (m.role === "tool") {
      messages.push({
        role: "toolResult",
        toolCallId: m.toolCallId ?? "",
        toolName: m.name ?? "",
        content: contentToParts(toPiInputContent(m.content)),
        isError: false,
        timestamp: 0,
      });
    } else if (m.role === "assistant") {
      const content: (TextContent | PiToolCall)[] = [];
      const text = messageText(m.content);
      if (text) content.push({ type: "text", text });
      for (const tc of m.toolCalls ?? []) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.arguments || "{}") as Record<string, unknown>;
        } catch {
          /* 坏 JSON → 空对象 */
        }
        content.push({ type: "toolCall", id: tc.id, name: tc.name, arguments: args });
      }
      messages.push({
        role: "assistant",
        content,
        api: "openai-completions",
        provider: "",
        model: "",
        usage: ZERO_USAGE,
        stopReason: "stop",
        timestamp: 0,
      });
    }
  }

  const ctx: PiContext = { messages };
  if (system) ctx.systemPrompt = system;
  if (req.tools?.length) ctx.tools = req.tools.map((t) => ({ name: t.name, description: t.description, parameters: Type.Unsafe(t.parameters) }));
  return ctx;
}

function contentToParts(c: string | (TextContent | ImageContent)[]): (TextContent | ImageContent)[] {
  return typeof c === "string" ? [{ type: "text", text: c }] : c;
}

/** pi→ChatStreamEvent 适配的可变状态（工具调用顺序索引）。 */
export interface PiAdaptState {
  toolIndex: number;
}
export function newPiAdaptState(): PiAdaptState {
  return { toolIndex: 0 };
}

function mapFinish(reason: "stop" | "length" | "toolUse"): FinishReason {
  return reason === "toolUse" ? "tool_calls" : reason;
}

/** pi stopReason → 我们的 FinishReason（非流式 completeSimple 用）。 */
function mapStopReason(r: PiAssistantMessage["stopReason"]): FinishReason {
  if (r === "toolUse") return "tool_calls";
  if (r === "stop" || r === "length" || r === "error" || r === "aborted") return r;
  return "stop";
}

/** pi AssistantMessage（非流式结果）→ 我们的 ChatResponse（供 chatResponseToOpenAI/Anthropic）。 */
export function piAssistantToChatResponse(msg: PiAssistantMessage, model: string): ChatResponse {
  const u = msg.usage;
  return {
    message: piAssistantToChatMessage(msg),
    finishReason: mapStopReason(msg.stopReason),
    model: msg.model || model,
    ...(u ? { usage: { promptTokens: u.input, completionTokens: u.output, totalTokens: u.totalTokens } } : {}),
  };
}

/** pi AssistantMessage → 我们的 ChatMessage（文本 + 工具调用，arguments 转回 JSON 串）。 */
function piAssistantToChatMessage(msg: PiAssistantMessage): ChatMessage {
  const text = msg.content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text)
    .join("");
  const toolCalls = msg.content
    .filter((c): c is PiToolCall => c.type === "toolCall")
    .map((c) => ({ id: c.id, name: c.name, arguments: JSON.stringify(c.arguments ?? {}) }));
  return { role: "assistant", content: text, ...(toolCalls.length ? { toolCalls } : {}) };
}

/** pi AssistantMessageEvent → 我们的 ChatStreamEvent（0..n 条）。 */
export function piEventToChatStreamEvents(ev: AssistantMessageEvent, state: PiAdaptState): ChatStreamEvent[] {
  switch (ev.type) {
    case "text_delta":
      return [{ type: "text-delta", text: ev.delta }];
    case "thinking_delta":
      return [{ type: "reasoning-delta", text: ev.delta }];
    case "toolcall_end": {
      const idx = state.toolIndex++;
      const tc = ev.toolCall;
      return [
        { type: "tool-call-start", index: idx, id: tc.id, name: tc.name },
        { type: "tool-call-args-delta", index: idx, delta: JSON.stringify(tc.arguments ?? {}) },
        { type: "tool-call-end", index: idx },
      ];
    }
    case "done": {
      const out: ChatStreamEvent[] = [];
      const u = ev.message.usage;
      if (u) out.push({ type: "usage", usage: { promptTokens: u.input, completionTokens: u.output, totalTokens: u.totalTokens } });
      out.push({ type: "done", finishReason: mapFinish(ev.reason), message: piAssistantToChatMessage(ev.message) });
      return out;
    }
    case "error":
      return [{ type: "error", message: ev.error.errorMessage ?? "provider_error" }];
    default:
      return [];
  }
}
