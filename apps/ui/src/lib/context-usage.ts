import type { UiMsg } from "./agent-stream.js";

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ComposerUsageState {
  pct: number | null;
  title?: string;
  parts?: ContextUsagePart[];
}

export interface ContextUsagePart {
  key: "unclassified" | "user" | "assistant" | "tools" | "output" | "other" | "available";
  label: string;
  tokens: number;
  pct: number;
  estimated?: boolean;
}

export function formatTokenCount(tokens: number): string {
  return Math.round(tokens).toLocaleString("en-US");
}

export function formatUsagePct(pct: number): string {
  return `${Number(pct.toFixed(1))}%`;
}

function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimatedInputParts(messages: UiMsg[], promptTokens: number): Array<Omit<ContextUsagePart, "pct">> {
  const lastAssistantIndex = messages.reduce((last, message, index) => (message.role === "assistant" ? index : last), -1);
  let user = 0;
  let assistant = 0;
  let tools = 0;

  messages.forEach((message, index) => {
    if (message.role === "user") {
      user += estimateTextTokens(message.raw);
      return;
    }
    if (index !== lastAssistantIndex) assistant += estimateTextTokens(`${message.reasoning}\n${message.raw}`);
    for (const tool of message.tools) {
      tools += estimateTextTokens(`${tool.name}\n${tool.args}\n${tool.result ?? ""}\n${tool.output ?? ""}`);
    }
  });

  const estimatedTotal = user + assistant + tools;
  const scale = estimatedTotal > promptTokens && estimatedTotal > 0 ? promptTokens / estimatedTotal : 1;
  const scaledUser = Math.floor(user * scale);
  const scaledAssistant = Math.floor(assistant * scale);
  const scaledTools = Math.min(promptTokens - scaledUser - scaledAssistant, Math.floor(tools * scale));
  const unclassified = Math.max(0, promptTokens - scaledUser - scaledAssistant - scaledTools);
  return [
    { key: "unclassified", label: "其余输入（系统等）", tokens: unclassified, estimated: true },
    ...(scaledUser > 0 ? [{ key: "user" as const, label: "用户消息", tokens: scaledUser, estimated: true }] : []),
    ...(scaledAssistant > 0
      ? [{ key: "assistant" as const, label: "助手历史", tokens: scaledAssistant, estimated: true }]
      : []),
    ...(scaledTools > 0 ? [{ key: "tools" as const, label: "工具调用", tokens: scaledTools, estimated: true }] : []),
  ];
}

export function composerUsageState(
  usage: TokenUsage | null,
  contextLimit?: number,
  messages: UiMsg[] = [],
): ComposerUsageState {
  if (contextLimit == null || contextLimit <= 0) return { pct: null };
  if (!usage) return { pct: null, title: `上下文窗口 ${contextLimit} tokens` };

  const inputTokens = Math.max(0, usage.promptTokens);
  const outputTokens = Math.max(0, usage.completionTokens);
  const usedTokens = Math.max(0, usage.totalTokens, inputTokens + outputTokens);
  const otherTokens = Math.max(0, usedTokens - inputTokens - outputTokens);
  const availableTokens = Math.max(0, contextLimit - usedTokens);
  const pctOfWindow = (tokens: number) => (tokens / contextLimit) * 100;
  const pct = pctOfWindow(usedTokens);
  const inputParts = estimatedInputParts(messages, inputTokens);
  const parts: ContextUsagePart[] = [
    ...inputParts.map((part) => ({ ...part, pct: pctOfWindow(part.tokens) })),
    { key: "output", label: "本轮输出", tokens: outputTokens, pct: pctOfWindow(outputTokens) },
    ...(otherTokens > 0
      ? [
          {
            key: "other" as const,
            label: "其他开销",
            tokens: otherTokens,
            pct: pctOfWindow(otherTokens),
          },
        ]
      : []),
    {
      key: "available",
      label: "可用空间",
      tokens: availableTokens,
      pct: pctOfWindow(availableTokens),
    },
  ];
  return {
    pct,
    title: `上下文已用 ${formatUsagePct(pct)} · ${formatTokenCount(usedTokens)}/${formatTokenCount(contextLimit)} tokens`,
    parts,
  };
}
