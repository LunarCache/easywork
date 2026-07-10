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
  onDiscard?: () => void;
}

function terminalStopReason(ev: AgentSessionEvent): string | undefined {
  if (ev.type !== "agent_end" || ev.willRetry) return undefined;
  const messages = (ev as { messages?: Array<{ role?: string; stopReason?: string }> }).messages ?? [];
  return [...messages].reverse().find((m) => m.role === "assistant")?.stopReason;
}

function rollbackTurn(session: AgentSession, snapshot: typeof session.agent.state.messages, leafId: string | null): void {
  try {
    if (leafId) session.sessionManager.branch(leafId);
    else session.sessionManager.resetLeaf();
  } catch {
    /* fake sessions / older pi versions: fall back to state reset below */
  }
  try {
    session.agent.state.messages = snapshot;
  } catch {
    /* 回滚失败不致命：下轮仍可继续 */
  }
}

/**
 * Agent Runtime 的 single-turn event pump：订阅 pi session、启动 prompt、把事件排队成
 * AgentEvent 流，并在用户取消或本轮失败时回滚上下文。
 */
export async function* runAgentTurn(input: RunAgentTurnInput): AsyncGenerator<AgentEvent> {
  const session = input.session;
  // 取消 / provider 断流失败「不计入上下文」：快照本轮 prompt 前的会话消息和 session leaf。
  const snapshot = session.agent.state.messages.slice();
  const snapshotLeafId = session.sessionManager?.getLeafId?.() ?? null;

  const queue: AgentEvent[] = [];
  let notify: (() => void) | null = null;
  let done = false;
  let failed: string | null = null;
  let discardTurn = false;
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
        const reason = terminalStopReason(ev);
        if (reason === "error" || reason === "aborted") discardTurn = true;
        done = true;
        wake();
      }
    } catch (err) {
      failed = err instanceof Error ? err.message : String(err);
      discardTurn = true;
      done = true;
      wake();
    }
  });

  const promptDone = session
    .prompt(input.text, input.images?.length ? { images: input.images } : undefined)
    .catch((err: unknown) => {
      failed = err instanceof Error ? err.message : String(err);
      discardTurn = true;
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
    if (input.signal?.aborted || discardTurn) {
      if (discardTurn && !input.signal?.aborted) input.onDiscard?.();
      rollbackTurn(session, snapshot, snapshotLeafId);
    }
  }
}
