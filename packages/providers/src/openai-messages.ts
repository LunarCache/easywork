import { normalizeContent, type ChatMessage, type ContentPart, type ToolDefinition } from "@ew/shared";

/** ContentPart[] → OpenAI content（string 或 多模态数组）。 */
function toOpenAIContent(content: ChatMessage["content"]): unknown {
  // reasoning 仅用于持久化与回放展示，绝不发给模型 —— 在最前过滤掉。
  const parts = normalizeContent(content).filter((p) => p.type !== "reasoning");
  // 全是文本则用简单字符串。
  if (parts.every((p) => p.type === "text")) {
    return parts.map((p) => (p as Extract<ContentPart, { type: "text" }>).text).join("");
  }
  return parts.map((p) => {
    if (p.type === "text") return { type: "text", text: p.text };
    if (p.type === "image") {
      const url = typeof p.data === "string" ? `data:${p.mimeType};base64,${p.data}` : p.data.url;
      return { type: "image_url", image_url: { url } };
    }
    // audio/file：多数 OpenAI 兼容端点不支持，降级为文本占位。
    return { type: "text", text: `[${p.type}]` };
  });
}

/** ChatMessage[] → OpenAI messages[]。 */
export function toOpenAIMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === "assistant" && m.toolCalls?.length) {
      return {
        role: "assistant",
        content: toOpenAIContent(m.content) || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.arguments },
        })),
      };
    }
    if (m.role === "tool") {
      return { role: "tool", tool_call_id: m.toolCallId, content: toOpenAIContent(m.content) };
    }
    const base: Record<string, unknown> = { role: m.role, content: toOpenAIContent(m.content) };
    if (m.name) base.name = m.name;
    return base;
  });
}

/** ToolDefinition[] → OpenAI tools[]。 */
export function toOpenAITools(tools: ToolDefinition[] | undefined): unknown[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}
