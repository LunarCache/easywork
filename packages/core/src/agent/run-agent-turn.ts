import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentEvent } from "@ew/shared";

interface RunAgentTurnInput {
  session: AgentSession;
  text: string;
  images?: ImageContent[];
  signal?: AbortSignal;
  mapEvent: (ev: AgentSessionEvent) => AgentEvent[];
  onAbort?: () => void;
}

/**
 * Agent Runtime 的 single-turn event pump：订阅 pi session、启动 prompt、把事件排队成
 * AgentEvent 流，并在用户取消时回滚本轮上下文。
 */
export async function* runAgentTurn(input: RunAgentTurnInput): AsyncGenerator<AgentEvent> {
  const session = input.session;
  // 用户取消「不计入上下文」：快照本轮 prompt 前的会话消息，取消时回滚到此。
  const snapshot = session.agent.state.messages.slice();

  const queue: AgentEvent[] = [];
  let notify: (() => void) | null = null;
  let done = false;
  let failed: string | null = null;
  const wake = (): void => {
    const n = notify;
    notify = null;
    n?.();
  };
  const push = (e: AgentEvent): void => {
    queue.push(e);
    wake();
  };

  const onAbort = (): void => {
    input.onAbort?.();
    void session.abort().catch(() => {});
  };
  if (input.signal) {
    if (input.signal.aborted) onAbort();
    else input.signal.addEventListener("abort", onAbort);
  }

  const unsub = session.subscribe((ev) => {
    try {
      for (const mapped of input.mapEvent(ev)) push(mapped);
      // 自动重试 / 自动压缩会先发 agent_end{willRetry:true} 再 continue。
      // 只在真正收尾（willRetry=false）时结束本轮。
      if (ev.type === "agent_end" && !ev.willRetry) {
        done = true;
        wake();
      }
    } catch (err) {
      failed = err instanceof Error ? err.message : String(err);
      done = true;
      wake();
    }
  });

  const promptDone = session
    .prompt(input.text, input.images?.length ? { images: input.images } : undefined)
    .catch((err: unknown) => {
      failed = err instanceof Error ? err.message : String(err);
      done = true;
      wake();
    });

  try {
    while (true) {
      while (queue.length) yield queue.shift()!;
      if (done) break;
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
    }
    while (queue.length) yield queue.shift()!;
    await promptDone;
    if (failed) yield { type: "error", message: failed };
  } finally {
    unsub();
    input.signal?.removeEventListener("abort", onAbort);
    if (input.signal?.aborted) {
      try {
        session.agent.state.messages = snapshot;
      } catch {
        /* 回滚失败不致命：下轮仍可继续 */
      }
    }
  }
}
