import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ChatStreamEvent,
  ContentPart,
  ToolCall,
  ToolChoice,
  ToolDefinition,
} from "@ew/shared";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** OpenAI 入站 content → 我们的 ContentPart[]。 */
function fromOpenAIContent(content: any): string | ContentPart[] {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content);
  const parts: ContentPart[] = [];
  for (const p of content) {
    if (p?.type === "text") parts.push({ type: "text", text: p.text ?? "" });
    else if (p?.type === "image_url") {
      const url: string = p.image_url?.url ?? "";
      const m = /^data:([^;]+);base64,(.*)$/.exec(url);
      if (m) parts.push({ type: "image", mimeType: m[1]!, data: m[2]! });
      else parts.push({ type: "image", mimeType: "image/*", data: { url } });
    }
  }
  return parts.length ? parts : "";
}

/** OpenAI 入站请求 body → 我们的 ChatRequest。 */
export function openaiToChatRequest(body: any): ChatRequest {
  const messages: ChatMessage[] = (body.messages ?? []).map((m: any): ChatMessage => {
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
      const toolCalls: ToolCall[] = m.tool_calls.map((tc: any) => ({
        id: tc.id,
        name: tc.function?.name ?? "",
        arguments: tc.function?.arguments ?? "",
      }));
      return { role: "assistant", content: fromOpenAIContent(m.content), toolCalls };
    }
    if (m.role === "tool") {
      return { role: "tool", content: fromOpenAIContent(m.content), toolCallId: m.tool_call_id };
    }
    return {
      role: m.role,
      content: fromOpenAIContent(m.content),
      ...(m.name ? { name: m.name } : {}),
    };
  });

  const tools: ToolDefinition[] | undefined = Array.isArray(body.tools)
    ? body.tools.map((t: any) => ({
        name: t.function?.name ?? t.name,
        description: t.function?.description ?? "",
        parameters: t.function?.parameters ?? {},
      }))
    : undefined;

  let toolChoice: ToolChoice | undefined;
  if (typeof body.tool_choice === "string") toolChoice = body.tool_choice as ToolChoice;
  else if (body.tool_choice?.function?.name)
    toolChoice = { name: body.tool_choice.function.name };

  return {
    model: body.model,
    messages,
    ...(tools ? { tools } : {}),
    ...(toolChoice ? { toolChoice } : {}),
    ...(body.temperature != null ? { temperature: body.temperature } : {}),
    ...(body.top_p != null ? { topP: body.top_p } : {}),
    ...(body.top_k != null ? { topK: body.top_k } : {}),
    ...(body.min_p != null ? { minP: body.min_p } : {}),
    ...(body.repeat_penalty != null ? { repeatPenalty: body.repeat_penalty } : {}),
    ...(body.frequency_penalty != null ? { frequencyPenalty: body.frequency_penalty } : {}),
    ...(body.presence_penalty != null ? { presencePenalty: body.presence_penalty } : {}),
    ...(body.max_tokens != null ? { maxTokens: body.max_tokens } : {}),
    ...(body.stop ? { stop: Array.isArray(body.stop) ? body.stop : [body.stop] } : {}),
    ...(body.seed != null ? { seed: body.seed } : {}),
    ...(body.reasoning_effort != null ? { reasoningEffort: body.reasoning_effort } : {}),
  };
}

function contentToString(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("");
}

const FINISH_MAP: Record<string, string> = {
  stop: "stop",
  length: "length",
  tool_calls: "tool_calls",
  content_filter: "content_filter",
  aborted: "stop",
  error: "stop",
};

/** 我们的 ChatResponse → OpenAI 非流式响应对象。 */
export function chatResponseToOpenAI(res: ChatResponse, id: string, created: number): object {
  const msg: any = { role: "assistant", content: contentToString(res.message.content) };
  if (res.message.toolCalls?.length) {
    msg.tool_calls = res.message.toolCalls.map((tc) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: tc.arguments },
    }));
  }
  return {
    id,
    object: "chat.completion",
    created,
    model: res.model,
    choices: [{ index: 0, message: msg, finish_reason: FINISH_MAP[res.finishReason] ?? "stop" }],
    usage: res.usage
      ? {
          prompt_tokens: res.usage.promptTokens,
          completion_tokens: res.usage.completionTokens,
          total_tokens: res.usage.totalTokens,
        }
      : undefined,
  };
}

/** 把一个 ChatStreamEvent 转成 0..N 个 OpenAI chunk（已 JSON.stringify 的 data 负载）。 */
export function streamEventToOpenAIChunks(
  ev: ChatStreamEvent,
  ctx: { id: string; created: number; model: string; roleSent: { value: boolean } },
): string[] {
  const base = { id: ctx.id, object: "chat.completion.chunk", created: ctx.created, model: ctx.model };
  const out: string[] = [];
  const emit = (choice: object) => out.push(JSON.stringify({ ...base, choices: [choice] }));

  const ensureRole = (delta: Record<string, unknown>) => {
    if (!ctx.roleSent.value) {
      ctx.roleSent.value = true;
      return { role: "assistant", ...delta };
    }
    return delta;
  };

  switch (ev.type) {
    case "text-delta":
      emit({ index: 0, delta: ensureRole({ content: ev.text }), finish_reason: null });
      break;
    case "tool-call-start":
      emit({
        index: 0,
        delta: ensureRole({
          tool_calls: [{ index: ev.index, id: ev.id, type: "function", function: { name: ev.name, arguments: "" } }],
        }),
        finish_reason: null,
      });
      break;
    case "tool-call-args-delta":
      emit({
        index: 0,
        delta: { tool_calls: [{ index: ev.index, function: { arguments: ev.delta } }] },
        finish_reason: null,
      });
      break;
    case "done":
      emit({
        index: 0,
        delta: {},
        finish_reason: FINISH_MAP[ev.finishReason] ?? "stop",
      });
      break;
    // usage / reasoning / tool-call-end / error 在此略过（reasoning 可扩展为 delta.reasoning_content）。
    default:
      break;
  }
  return out;
}
