export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ComposerUsageState {
  pct: number | null;
  title?: string;
}

export function composerUsageState(usage: TokenUsage | null, contextLimit?: number): ComposerUsageState {
  if (contextLimit == null || contextLimit <= 0) return { pct: null };
  if (!usage) return { pct: null, title: `上下文窗口 ${contextLimit} tokens` };

  const pct = (usage.promptTokens / contextLimit) * 100;
  return {
    pct,
    title: `上下文已用 ${Math.round(pct)}% · ${usage.promptTokens}/${contextLimit} tokens`,
  };
}
