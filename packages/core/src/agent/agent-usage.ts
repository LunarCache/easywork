export interface AgentTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export type PiUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
};

/** pi Usage → 完整提示词 token（含缓存命中/写入；只取 input 会在 prompt cache 活跃时严重低估上下文占用）。 */
export function promptTokensOf(u: { input: number; cacheRead: number; cacheWrite: number }): number {
  return u.input + u.cacheRead + u.cacheWrite;
}
