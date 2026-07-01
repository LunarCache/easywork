import type {
  ChannelOutbound,
  ChannelAdapterMeta,
  ChannelConfig,
  ChannelStatus,
  ChannelTarget,
  InboundMessage,
  OutboundChunk,
} from "@ew/shared";
import type { ChannelAdapter, WebhookRequest, WebhookResult } from "./adapter.js";
import { ChannelAdapterRegistry } from "./registry.js";

export interface ChannelGatewayDeps {
  registry: ChannelAdapterRegistry;
  configs: ChannelConfig[];
  handleInbound(message: InboundMessage, adapter: ChannelGatewayReplyAdapter): Promise<void>;
}

export interface ChannelGatewayReplyAdapter {
  readonly kind: string;
  reply(target: ChannelTarget, stream: AsyncIterable<OutboundChunk>): Promise<void>;
}

interface Runtime {
  config: ChannelConfig;
  adapter: ChannelAdapter;
  status: ChannelStatus;
}

export class ChannelGateway {
  private readonly runtimes = new Map<string, Runtime>();

  constructor(private readonly deps: ChannelGatewayDeps) {
    for (const config of deps.configs) this.install(config);
  }

  metas(): ChannelAdapterMeta[] {
    return this.deps.registry.list().map((entry) => entry.meta);
  }

  configs(): ChannelConfig[] {
    return [...this.runtimes.values()].map((r) => r.config);
  }

  statuses(): ChannelStatus[] {
    return [...this.runtimes.values()].map((r) => ({ ...r.status }));
  }

  async upsert(config: ChannelConfig): Promise<ChannelStatus> {
    const existing = this.runtimes.get(config.id);
    if (existing) {
      await existing.adapter.stop().catch(() => {});
      this.runtimes.delete(config.id);
    }
    return { ...this.install(config).status };
  }

  async remove(id: string): Promise<boolean> {
    const runtime = this.runtimes.get(id);
    if (!runtime) return false;
    await runtime.adapter.stop().catch(() => {});
    this.runtimes.delete(id);
    return true;
  }

  async startAll(): Promise<void> {
    for (const runtime of this.runtimes.values()) {
      if (runtime.config.enabled) await this.start(runtime.config.id);
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.runtimes.values()].map((runtime) => runtime.adapter.stop().catch(() => {})));
    for (const runtime of this.runtimes.values()) {
      runtime.status.running = false;
    }
  }

  async start(id: string): Promise<ChannelStatus> {
    const runtime = this.requireRuntime(id);
    if (runtime.status.running) return { ...runtime.status };
    try {
      await runtime.adapter.start({
        config: runtime.config,
        emitInbound: async (msg) => {
          runtime.status.lastInboundAt = new Date().toISOString();
          if (!this.isInboundAllowed(runtime.config, msg)) {
            runtime.status.lastError = "inbound_not_allowed";
            return;
          }
          await this.deps.handleInbound(msg, this.replyAdapter(runtime));
        },
        setStatus: (patch) => {
          runtime.status = { ...runtime.status, ...patch };
        },
      });
      runtime.status.running = true;
      runtime.status.lastError = undefined;
    } catch (err) {
      runtime.status.running = false;
      runtime.status.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
    return { ...runtime.status };
  }

  async stop(id: string): Promise<ChannelStatus> {
    const runtime = this.requireRuntime(id);
    await runtime.adapter.stop();
    runtime.status.running = false;
    return { ...runtime.status };
  }

  async handleWebhook(id: string, req: WebhookRequest): Promise<WebhookResult> {
    const runtime = this.requireRuntime(id);
    if (!runtime.adapter.handleWebhook) {
      return { status: 404, body: { error: "webhook_not_supported" } };
    }
    return runtime.adapter.handleWebhook(req);
  }

  async reply(id: string, target: ChannelTarget, stream: AsyncIterable<OutboundChunk>): Promise<void> {
    const runtime = this.requireRuntime(id);
    let text = "";
    const attachments: NonNullable<ChannelOutbound["attachments"]> = [];
    for await (const chunk of stream) {
      if (chunk.text) text += chunk.text;
      if (chunk.attachments) attachments.push(...chunk.attachments);
    }
    const result = await runtime.adapter.send(
      target,
      { text: text.trim() || "(无内容)", attachments },
    );
    runtime.status.lastOutboundAt = new Date().toISOString();
    if (!result.ok) runtime.status.lastError = result.error || "send_failed";
  }

  private install(config: ChannelConfig): Runtime {
    const entry = this.deps.registry.get(config.kind);
    if (!entry) throw new Error(`Unknown channel adapter: ${config.kind}`);
    const adapter = entry.create(config);
    const runtime: Runtime = {
      config,
      adapter,
      status: {
        id: config.id,
        kind: config.kind,
        enabled: config.enabled,
        running: false,
        ...(config.displayName ? { displayName: config.displayName } : {}),
      },
    };
    this.runtimes.set(config.id, runtime);
    return runtime;
  }

  private requireRuntime(id: string): Runtime {
    const runtime = this.runtimes.get(id);
    if (!runtime) throw new Error(`Unknown channel connector: ${id}`);
    return runtime;
  }

  private isInboundAllowed(config: ChannelConfig, message: InboundMessage): boolean {
    const auth = config.auth;
    if (auth.allowAll) return true;
    if (auth.allowedUsers?.includes(message.channelUserId)) return true;
    if (auth.allowedChats?.includes(message.channelChatId)) return true;
    return false;
  }

  private replyAdapter(runtime: Runtime): ChannelGatewayReplyAdapter {
    return {
      kind: runtime.adapter.kind,
      reply: (target, stream) => this.reply(runtime.config.id, target, stream),
    };
  }
}
