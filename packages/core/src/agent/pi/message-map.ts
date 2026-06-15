// 我们的 ChatMessage[] ↔ pi Message[] 转换。
// - system 消息折叠进 pi 的 systemPrompt（pi Context 把 system 独立出来）。
// - user/assistant/tool → UserMessage/AssistantMessage/ToolResultMessage。
import type { AssistantMessage, Message, TextContent } from "@earendil-works/pi-ai";
import type { ChatMessage, ContentPart } from "@ew/shared";
import { messageText } from "@ew/shared";

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function piUserContent(content: ChatMessage["content"]): string | TextContent[] {
  if (typeof content === "string") return content;
  // 仅文本/图片有意义；这里输入历史以文本为主，图片透传。
  const parts = content as ContentPart[];
  const out: TextContent[] = parts
    .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
    .map((p) => ({ type: "text", text: p.text }));
  return out.length ? out : "";
}

/**
 * 把我们的对话历史拆成 pi 的 systemPrompt + Message[]。
 * @param model 用于填充 assistant 消息的 model 字段（pi 要求）。
 */
export function ewHistoryToPi(
  history: ChatMessage[],
  model: string,
): { systemPrompt: string; messages: Message[] } {
  const systemParts: string[] = [];
  const messages: Message[] = [];
  const ts = 0; // 确定性时间戳（避免不可复现），pi 仅用于排序展示
  for (const m of history) {
    if (m.role === "system") {
      const t = messageText(m.content);
      if (t.trim()) systemParts.push(t);
    } else if (m.role === "user") {
      messages.push({ role: "user", content: piUserContent(m.content), timestamp: ts });
    } else if (m.role === "assistant") {
      const text = messageText(m.content);
      const assistant: AssistantMessage = {
        role: "assistant",
        content: text ? [{ type: "text", text }] : [],
        api: "openai-completions",
        provider: "local",
        model,
        usage: ZERO_USAGE,
        stopReason: "stop",
        timestamp: ts,
      };
      // 历史里的 tool 调用块（一般来自我们重建的存档）。
      for (const tc of m.toolCalls ?? []) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.arguments || "{}") as Record<string, unknown>;
        } catch {
          args = {};
        }
        assistant.content.push({ type: "toolCall", id: tc.id, name: tc.name, arguments: args });
      }
      messages.push(assistant);
    } else if (m.role === "tool") {
      messages.push({
        role: "toolResult",
        toolCallId: m.toolCallId ?? "",
        toolName: "",
        content: [{ type: "text", text: messageText(m.content) }],
        isError: false,
        timestamp: ts,
      });
    }
  }
  return { systemPrompt: systemParts.join("\n\n"), messages };
}
