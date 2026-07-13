import { MemoryItemSchema, MemoryWriteSchema } from "@ew/shared";
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
    const data = (await res.json()) as {
      results?: { id: string; memory: string; score?: number }[];
    };
    return (data.results ?? []).map((m) => ({
      id: m.id,
      layer: "agent-notes" as const,
      text: m.memory,
      origin: "provider" as const,
      state: "curated" as const,
      ...(m.score != null ? { score: m.score } : {}),
      updatedAt: new Date().toISOString(),
    }));
  }

  async write(item: MemoryWrite): Promise<MemoryItem> {
    const parsed = MemoryWriteSchema.parse(item);
    if (parsed.state === "derived" || parsed.sourceThreadId || parsed.sessionId) {
      throw new Error("Mem0 adapter does not support source-owned derived facts");
    }
    await this.fetchImpl(`${this.baseUrl}/v1/memories/`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        messages: [{ role: "user", content: parsed.text }],
      }),
    }).catch(() => undefined);
    return MemoryItemSchema.parse({
      id: "mem0",
      updatedAt: new Date().toISOString(),
      ...parsed,
      origin: parsed.origin ?? "provider",
      state: parsed.state ?? "curated",
    });
  }

  async edit(id: string, patch: Partial<Pick<MemoryItem, "text" | "meta">>): Promise<MemoryItem> {
    return {
      id,
      layer: "agent-notes",
      text: patch.text ?? "",
      origin: "provider",
      state: "curated",
      updatedAt: new Date().toISOString(),
    };
  }

  async promote(): Promise<MemoryItem> {
    throw new Error("Mem0 promotion is not supported by this adapter");
  }

  async list(): Promise<MemoryItem[]> {
    return [];
  }

  async delete(): Promise<void> {
    /* 略 */
  }

  async deleteBySession(): Promise<number> {
    /* Mem0 以 user_id 分区；按会话清除待接入真实账号时补全。 */
    return 0;
  }

  async deleteByScope(): Promise<number> {
    /* Mem0 作用域映射待接入真实账号时补全。 */
    return 0;
  }

  async observe(input: { messages: unknown[]; sessionId: string }): Promise<void> {
    await this.fetchImpl(`${this.baseUrl}/v1/memories/`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ messages: input.messages, user_id: input.sessionId, infer: true }),
    }).catch(() => undefined);
  }
}
