import { MemoryItemSchema, type MemoryItem, type MemoryProvider, type MemoryWrite, type RecallQuery } from "@ew/shared";

const UNSAFE = [
  /ignore (?:all )?(?:previous|prior) instructions/i,
  /override (?:the )?(?:system|developer) (?:prompt|instructions)/i,
  /\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*[^\s]{6,}/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];

/**
 * 本地 Core Memory 永远是主存；外部 provider 只追加受限 recall，失败/禁用/移除不影响本地读写。
 */
export class AdditiveMemoryProvider implements MemoryProvider {
  readonly id = "additive";
  private enabled = true;

  constructor(
    private readonly local: MemoryProvider,
    private readonly provider?: MemoryProvider,
  ) {}

  setProviderEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  providerStatus(): { configured: boolean; enabled: boolean; id?: string } {
    return { configured: !!this.provider, enabled: !!this.provider && this.enabled, ...(this.provider ? { id: this.provider.id } : {}) };
  }

  async recall(query: RecallQuery): Promise<MemoryItem[]> {
    const local = await this.local.recall(query);
    if (!this.provider || !this.enabled) return local;
    let external: MemoryItem[] = [];
    try {
      external = await this.provider.recall({ ...query, topK: Math.min(query.topK ?? 6, 4) });
    } catch {
      return local;
    }
    let chars = 0;
    const safe = external.flatMap((item) => {
      const text = item.text.trim().slice(0, 400);
      if (!text || UNSAFE.some((pattern) => pattern.test(text)) || chars + text.length > 1000) return [];
      const parsed = MemoryItemSchema.safeParse({
        ...item,
        text,
        origin: "provider" as const,
        state: "curated" as const,
        sourceThreadId: undefined,
        sessionId: undefined,
        meta: { ...(item.meta ?? {}), providerId: this.provider!.id, untrusted: true },
      });
      if (!parsed.success) return [];
      chars += text.length;
      return [parsed.data];
    });
    const seen = new Set(local.map((item) => item.id));
    return [...local, ...safe.filter((item) => !seen.has(item.id))]
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, query.topK ?? 6);
  }

  write(item: MemoryWrite): Promise<MemoryItem> { return this.local.write(item); }
  edit(id: string, patch: Partial<Pick<MemoryItem, "text" | "meta">>): Promise<MemoryItem> { return this.local.edit(id, patch); }
  promote(id: string, opts?: { promotedBy?: "user" | "agent" }): Promise<MemoryItem> { return this.local.promote(id, opts); }
  list(filter?: Parameters<MemoryProvider["list"]>[0]): Promise<MemoryItem[]> { return this.local.list(filter); }
  delete(id: string): Promise<void> { return this.local.delete(id); }
  deleteBySession(sessionId: string): Promise<number> { return this.local.deleteBySession(sessionId); }
  deleteByScope(scope: string): Promise<number> { return this.local.deleteByScope(scope); }

  async observe(input: { messages: unknown[]; sessionId: string; scope?: string; model?: string }): Promise<void> {
    await this.local.observe(input);
  }
}
