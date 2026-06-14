import type { MemoryItem, MemoryProvider, MemoryWrite, RecallQuery } from "@ew/shared";

export interface Mem0Options {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

/**
 * Mem0 适配器骨架（外部记忆服务）。证明 MemoryProvider 可插拔。
 * 真实接线对照 Mem0 REST：recall→search、write→add、observe→add(infer)。
 * 这里给出最小可编译实现，细节待接入真实账号时补全。
 */
export class Mem0MemoryProvider implements MemoryProvider {
  readonly id = "mem0";
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: Mem0Options) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? "https://api.mem0.ai").replace(/\/$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
  }

  private headers(): Record<string, string> {
    return { authorization: `Token ${this.apiKey}`, "content-type": "application/json" };
  }

  async recall(q: RecallQuery): Promise<MemoryItem[]> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/memories/search/`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ query: q.query, user_id: q.sessionId, limit: q.topK ?? 6 }),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { results?: { id: string; memory: string; score?: number }[] };
    return (data.results ?? []).map((m) => ({
      id: m.id,
      layer: "agent-memory" as const,
      text: m.memory,
      ...(m.score != null ? { score: m.score } : {}),
      updatedAt: new Date().toISOString(),
    }));
  }

  async write(item: MemoryWrite): Promise<MemoryItem> {
    await this.fetchImpl(`${this.baseUrl}/v1/memories/`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        messages: [{ role: "user", content: item.text }],
        user_id: item.sessionId,
      }),
    }).catch(() => undefined);
    return { id: "mem0", updatedAt: new Date().toISOString(), ...item };
  }

  async edit(id: string, patch: Partial<Pick<MemoryItem, "text" | "meta">>): Promise<MemoryItem> {
    return { id, layer: "agent-memory", text: patch.text ?? "", updatedAt: new Date().toISOString() };
  }

  async list(): Promise<MemoryItem[]> {
    return [];
  }

  async delete(): Promise<void> {
    /* 略 */
  }

  async observe(input: { messages: unknown[]; sessionId: string }): Promise<void> {
    await this.fetchImpl(`${this.baseUrl}/v1/memories/`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ messages: input.messages, user_id: input.sessionId, infer: true }),
    }).catch(() => undefined);
  }
}
