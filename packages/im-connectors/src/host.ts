import {
  type AgentEvent,
  type ChannelConnector,
  type ChannelTarget,
  type InboundMessage,
  type OutboundChunk,
} from "@ew/shared";

export interface ConnectorHostDeps {
  /** 把原始入站提交交给宿主的 Agent Turn interface，返回已完成生命周期管理的事件流。 */
  run(input: InboundMessage): AsyncIterable<AgentEvent>;
}

export interface ReplyAdapter {
  readonly kind: string;
  reply(target: ChannelTarget, stream: AsyncIterable<OutboundChunk>): Promise<void>;
}

/**
 * 连接器宿主：把任意 ChannelConnector 接到同一个 Agent Turn interface。
 * thread 映射、持久化与学习均由宿主拥有；这里仅做 inbound / outbound transport adapter。
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

  async handleInbound(connector: ReplyAdapter, msg: InboundMessage): Promise<void> {
    // 消费完整 Agent Turn 后，reply adapter 才执行外部投递；投递失败不回滚已完成的 turn。
    const deps = this.deps;
    async function* toChunks(): AsyncIterable<OutboundChunk> {
      for await (const ev of deps.run(msg)) {
        if (ev.type === "text") yield { text: ev.text };
        else if (ev.type === "final") {
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
  }
}
