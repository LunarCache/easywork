/**
 * Agent Runtime 的 run orchestration seam：按 threadId 串行化访问同一个 pi AgentSession。
 * pi 的会话级 subscribe / prompt / compact 不可并发复用；调用方拿到 release 后必须 finally 释放。
 */
export class ThreadRunQueue {
  private readonly chains = new Map<string, Promise<void>>();

  async acquire(threadId: string): Promise<() => void> {
    const prev = this.chains.get(threadId) ?? Promise.resolve();
    const waitForPrev = prev.catch(() => {});
    let release!: () => void;
    let released = false;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const current = waitForPrev.then(() => mine);
    this.chains.set(threadId, current);
    await waitForPrev;
    return () => {
      if (released) return;
      released = true;
      release();
      if (this.chains.get(threadId) === current) this.chains.delete(threadId);
    };
  }
}
