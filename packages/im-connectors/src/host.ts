import { randomUUID } from "node:crypto";
import {
  messageText,
  type AgentEvent,
  type AgentRunInput,
  type ChannelConnector,
  type ChannelTarget,
  type ChatMessage,
  type ConversationRepo,
  type InboundMessage,
  type OutboundChunk,
  type StoredMessage,
} from "@ew/shared";

export interface ConnectorHostDeps {
  repo: ConversationRepo & { nextSeq?(threadId: string): number };
  /** 运行 agent，返回 AgentEvent 流。 */
  run(input: AgentRunInput): AsyncIterable<AgentEvent>;
  /** 渠道会话默认模型。 */
  defaultModel: string;
  /** 是否持久化消息（默认 true）。 */
  persist?: boolean;
}

export interface ReplyAdapter {
  readonly kind: string;
  reply(target: ChannelTarget, stream: AsyncIterable<OutboundChunk>): Promise<void>;
}

/**
 * 连接器宿主：把任意 ChannelConnector 接到"同一个大脑"。
 * inbound → resolveThreadForChannel → 取历史 → runAgent → 把文本批量回复 → 持久化。
 */
export class ConnectorHost {
  private readonly connectors: ChannelConnector[] = [];

  constructor(private readonly deps: ConnectorHostDeps) {}

  attach(connector: ChannelConnector): void {
    connector.onInbound((msg) => this.handleInbound(connector, msg));
    this.connectors.push(connector);
  }

  async startAll(): Promise<void> {
    await Promise.all(this.connectors.map((c) => c.start()));
  }

  async stopAll(): Promise<void> {
    await Promise.all(this.connectors.map((c) => c.stop()));
  }

  private seq(threadId: string): number {
    return this.deps.repo.nextSeq ? this.deps.repo.nextSeq(threadId) : 0;
  }

  async handleInbound(connector: ReplyAdapter, msg: InboundMessage): Promise<void> {
    const persist = this.deps.persist !== false;
    const thread = this.deps.repo.resolveThreadForChannel(msg.channel, msg.channelUserId, {
      modelId: this.deps.defaultModel,
    });
    const model = thread.modelId || this.deps.defaultModel;

    // 取历史并拼上本轮用户消息。
    const prior = this.deps.repo.history(thread.id);
    const history: ChatMessage[] = prior.map((m) => ({ role: m.role, content: m.parts }));
    history.push({ role: "user", content: msg.parts });

    if (persist) {
      const userMsg: StoredMessage = {
        id: randomUUID(),
        threadId: thread.id,
        role: "user",
        seq: this.seq(thread.id),
        parts: msg.parts,
        createdAt: new Date().toISOString(),
      };
      this.deps.repo.appendMessage(userMsg);
    }

    // 运行 agent，把事件转成出站分块。
    let finalText = "";
    const deps = this.deps;
    async function* toChunks(): AsyncIterable<OutboundChunk> {
      for await (const ev of deps.run({ threadId: thread.id, model, history })) {
        if (ev.type === "text") yield { text: ev.text };
        else if (ev.type === "final") {
          finalText = messageText(ev.message.content);
          yield { final: true };
        } else if (ev.type === "error") {
          yield { text: `\n[错误] ${ev.message}`, final: true };
        }
      }
    }

    await connector.reply(
      {
        channelChatId: msg.channelChatId,
        ...(msg.channelThreadId ? { channelThreadId: msg.channelThreadId } : {}),
        ...(msg.messageId ? { replyToMessageId: msg.messageId } : {}),
      },
      toChunks(),
    );

    if (persist && finalText) {
      const asstMsg: StoredMessage = {
        id: randomUUID(),
        threadId: thread.id,
        role: "assistant",
        seq: this.seq(thread.id),
        parts: [{ type: "text", text: finalText }],
        createdAt: new Date().toISOString(),
      };
      this.deps.repo.appendMessage(asstMsg);
    }
  }
}
