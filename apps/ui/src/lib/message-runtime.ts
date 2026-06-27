import type { ChatMessage } from "@ew/shared";
import { splitThink, type UiImage, type UiMsg } from "./agent-stream.js";

export function toRunHistory(msgs: UiMsg[]): ChatMessage[] {
  return msgs.map((msg) => ({
    role: msg.role,
    content: msg.role === "assistant" ? splitThink(msg.raw).answer : msg.raw,
  }));
}

export function toUserContent(text: string, images: UiImage[]): ChatMessage["content"] {
  if (images.length === 0) return text;
  return [
    ...(text ? [{ type: "text" as const, text }] : []),
    ...images.map((image) => ({ type: "image" as const, mimeType: image.mimeType, data: image.data })),
  ];
}

export function appendUserTurn(msgs: UiMsg[], text: string, images: UiImage[]) {
  return [
    ...msgs,
    { role: "user" as const, raw: text, reasoning: "", tools: [], at: Date.now(), ...(images.length ? { images } : {}) },
    { role: "assistant" as const, raw: "", reasoning: "", tools: [] },
  ];
}

export function replaceLastAssistantTurn(msgs: UiMsg[], text: string) {
  const next = msgs.slice();
  for (let index = next.length - 1; index >= 0; index -= 1) {
    if (next[index]!.role === "user") {
      next[index] = { ...next[index]!, raw: text };
      break;
    }
  }
  while (next.length && next[next.length - 1]!.role === "assistant") next.pop();
  next.push({ role: "assistant", raw: "", reasoning: "", tools: [] });
  return next;
}

export function updateLastAssistant(msgs: UiMsg[], fn: (msg: UiMsg) => UiMsg) {
  if (msgs.length === 0) return msgs;
  const next = msgs.slice();
  next[next.length - 1] = fn(next[next.length - 1]!);
  return next;
}

export function markLastAssistantCancelled(msgs: UiMsg[]) {
  const next = msgs.slice();
  const last = next[next.length - 1];
  if (last && last.role === "assistant") next[next.length - 1] = { ...last, cancelled: true };
  return next;
}

export function findLastUser(msgs: UiMsg[]) {
  return [...msgs].reverse().find((msg) => msg.role === "user");
}
