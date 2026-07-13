/**
 * 被动记忆抽取的调度器（宿主拥有，而非 pi 扩展闭包）：
 * - 增量缓冲「自上次抽取以来的新轮次」（长突发也不漏早期轮次）；
 * - 缓冲达 maxTurns 立即分块抽取，否则空闲去抖 idleMs；
 * - flush() 在停模型前调用（关停/换模型），discard() 在删会话时丢弃不抽。
 * 与 pi 的压缩无耦合：缓冲独立于 pi 上下文，压缩不会丢失，也不触发并发抽取。
 */
export type ExtractionObserve = (input: {
  messages: { role: string; content: string }[];
  sessionId: string;
  scope: string;
  model: string;
}) => Promise<void>;

interface State {
  scope: string;
  model: string;
  buffer: { role: string; content: string }[];
  seenLen: number; // 已纳入缓冲的过滤后对话长度（列表变短=压缩 → 重新基线）
  timer?: ReturnType<typeof setTimeout>;
}

export class ExtractionScheduler {
  private readonly state = new Map<string, State>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly discarding = new Set<string>();
  private readonly idleMs: number;
  private readonly maxTurns: number;

  constructor(
    private readonly observe: ExtractionObserve,
    opts: { idleMs?: number; maxTurns?: number } = {},
  ) {
    this.idleMs = opts.idleMs ?? 90_000;
    this.maxTurns = opts.maxTurns ?? 24;
  }

  /** 转发本轮对话；累积新增轮次，达阈值立即抽、否则空闲去抖。 */
  note(threadId: string, scope: string, model: string, conv: { role: string; content: string }[]): void {
    if (this.discarding.has(threadId)) return;
    let st = this.state.get(threadId);
    if (!st) {
      st = { scope, model, buffer: [], seenLen: 0 };
      this.state.set(threadId, st);
    }
    st.scope = scope;
    st.model = model;
    st.buffer.push(...(conv.length >= st.seenLen ? conv.slice(st.seenLen) : conv));
    st.seenLen = conv.length;
    if (st.buffer.length === 0) return;
    if (st.buffer.length >= this.maxTurns) {
      void this.flush(threadId);
    } else {
      if (st.timer) clearTimeout(st.timer);
      st.timer = setTimeout(() => void this.flush(threadId), this.idleMs);
      st.timer.unref?.();
    }
  }

  /** 抽取某会话缓冲（await 完成；失败把批次放回缓冲下次重试）。 */
  async flush(threadId: string): Promise<void> {
    const active = this.inFlight.get(threadId);
    if (active) {
      await active;
      if (this.state.get(threadId)?.buffer.length) await this.flush(threadId);
      return;
    }
    const st = this.state.get(threadId);
    if (!st) return;
    if (st.timer) {
      clearTimeout(st.timer);
      st.timer = undefined;
    }
    if (st.buffer.length === 0) return;
    const batch = st.buffer;
    st.buffer = [];
    const task = this.observe({ messages: batch, sessionId: threadId, scope: st.scope, model: st.model }).catch(() => {
      // discard 已移除原 state 时不得复活待删会话；其他失败保留批次供下次重试。
      if (this.state.get(threadId) === st) st.buffer.unshift(...batch);
    });
    this.inFlight.set(threadId, task);
    try {
      await task;
    } finally {
      if (this.inFlight.get(threadId) === task) this.inFlight.delete(threadId);
    }
  }

  /** 丢弃缓冲并等待在途抽取落定；调用方随后删除派生事实，保证不会被迟到写入复活。 */
  async discard(threadId: string): Promise<void> {
    this.discarding.add(threadId);
    const st = this.state.get(threadId);
    if (st?.timer) clearTimeout(st.timer);
    this.state.delete(threadId);
    try {
      await this.inFlight.get(threadId);
    } finally {
      const recreated = this.state.get(threadId);
      if (recreated?.timer) clearTimeout(recreated.timer);
      this.state.delete(threadId);
      this.discarding.delete(threadId);
    }
  }

  /** flush 全部（关停前在停模型前调用）。 */
  async flushAll(): Promise<void> {
    await Promise.all([...this.state.keys()].map((id) => this.flush(id)));
  }
}
