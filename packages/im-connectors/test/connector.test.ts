import { describe, it, expect } from "vitest";
import type {
  AgentEvent,
  AgentRunInput,
  ChannelConnector,
  ConversationRepo,
  InboundMessage,
  OutboundChunk,
  StoredMessage,
  Thread,
} from "@ew/shared";
import { ConnectorHost } from "../src/host.js";
import { TelegramConnector } from "../src/telegram.js";

/** 内存版会话仓库（测试用）。 */
class FakeRepo implements ConversationRepo {
  private threads = new Map<string, Thread>();
  private msgs = new Map<string, StoredMessage[]>();
  private channelMap = new Map<string, string>();
  private n = 0;
  createThread(t: Partial<Thread>): Thread {
    const id = t.id ?? `t${++this.n}`;
    const now = new Date().toISOString();
    const thread: Thread = { id, title: t.title ?? "", modelId: t.modelId ?? "", createdAt: now, updatedAt: now, ...(t.channel ? { channel: t.channel } : {}) };
    this.threads.set(id, thread);
    this.msgs.set(id, []);
    return thread;
  }
  getThread(id: string): Thread | null {
    return this.threads.get(id) ?? null;
  }
  listThreads(): Thread[] {
    return [...this.threads.values()];
  }
  nextSeq(threadId: string): number {
    return (this.msgs.get(threadId)?.length ?? 0);
  }
  appendMessage(m: StoredMessage): void {
    this.msgs.get(m.threadId)?.push(m);
  }
  history(threadId: string): StoredMessage[] {
    return this.msgs.get(threadId) ?? [];
  }
  resolveThreadForChannel(kind: any, userId: string): Thread {
    const key = `${kind}:${userId}`;
    const existing = this.channelMap.get(key);
    if (existing) return this.threads.get(existing)!;
    const t = this.createThread({ channel: { kind, channelId: userId } });
    this.channelMap.set(key, t.id);
    return t;
  }
}

/** 假连接器：记录回复，可手动触发入站。 */
class FakeConnector implements ChannelConnector {
  readonly kind = "inapp" as const;
  replies: string[] = [];
  private handler?: (m: InboundMessage) => Promise<void>;
  onInbound(h: (m: InboundMessage) => Promise<void>): void {
    this.handler = h;
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async reply(_t: { channelChatId: string }, stream: AsyncIterable<OutboundChunk>): Promise<void> {
    let s = "";
    for await (const c of stream) if (c.text) s += c.text;
    this.replies.push(s);
  }
  trigger(m: InboundMessage): Promise<void> {
    return this.handler!(m);
  }
}

describe("ConnectorHost", () => {
  it("inbound → 路由到同一大脑 → 回复 → 持久化", async () => {
    const repo = new FakeRepo();
    const run = async function* (input: AgentRunInput): AsyncIterable<AgentEvent> {
      const last = input.history[input.history.length - 1];
      const text = `echo: ${(last?.content as any)[0].text}`;
      yield { type: "text", text };
      yield { type: "final", message: { role: "assistant", content: text } };
    };
    const host = new ConnectorHost({ repo, run, defaultModel: "m" });
    const conn = new FakeConnector();
    host.attach(conn);

    await conn.trigger({
      channel: "inapp",
      channelUserId: "u1",
      channelChatId: "c1",
      parts: [{ type: "text", text: "你好" }],
    });

    expect(conn.replies).toEqual(["echo: 你好"]);
    // 同一渠道用户映射到同一 thread，且消息已持久化（user + assistant）。
    const threads = repo.listThreads();
    expect(threads).toHaveLength(1);
    expect(repo.history(threads[0]!.id).map((m) => m.role)).toEqual(["user", "assistant"]);
  });
});

describe("TelegramConnector", () => {
  it("pollOnce 解析 getUpdates → 触发 inbound，并推进 offset", async () => {
    const calls: { method: string; body: any }[] = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      const method = url.split("/").pop()!;
      const body = JSON.parse(String(init?.body ?? "{}"));
      calls.push({ method, body });
      if (method === "getUpdates") {
        return new Response(
          JSON.stringify({
            result: [{ update_id: 10, message: { from: { id: 7 }, chat: { id: 77 }, text: "hello" } }],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const tg = new TelegramConnector({ token: "x", fetch: fakeFetch });
    const inbound: InboundMessage[] = [];
    tg.onInbound(async (m) => {
      inbound.push(m);
    });
    const n = await tg.pollOnce();
    expect(n).toBe(1);
    expect(inbound[0]!.channelUserId).toBe("7");
    expect(inbound[0]!.channelChatId).toBe("77");
    expect((inbound[0]!.parts[0] as any).text).toBe("hello");
    // 下一次 getUpdates offset 应为 11
    await tg.pollOnce();
    expect(calls.filter((c) => c.method === "getUpdates")[1]!.body.offset).toBe(11);
  });

  it("reply 累积文本后 sendMessage", async () => {
    const sent: any[] = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      const method = url.split("/").pop()!;
      if (method === "sendMessage") sent.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const tg = new TelegramConnector({ token: "x", fetch: fakeFetch });
    async function* chunks(): AsyncIterable<OutboundChunk> {
      yield { text: "hi " };
      yield { text: "there" };
      yield { final: true };
    }
    await tg.reply({ channelChatId: "77" }, chunks());
    expect(sent).toHaveLength(1);
    expect(sent[0].chat_id).toBe("77");
    expect(sent[0].text).toBe("hi there");
  });
});
