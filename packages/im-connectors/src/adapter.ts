import type {
  ChannelAdapterMeta,
  ChannelConfig,
  ChannelOutbound,
  ChannelStatus,
  ChannelTarget,
  InboundMessage,
} from "@ew/shared";

export interface SendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
  retryable?: boolean;
}

export interface WebhookRequest {
  method: string;
  path: string;
  query: Record<string, string | string[] | undefined>;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  rawBody?: string | Buffer;
}

export interface WebhookResult {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface ChannelAdapterContext {
  config: ChannelConfig;
  emitInbound(message: InboundMessage): Promise<void>;
  setStatus(patch: Partial<Omit<ChannelStatus, "id" | "kind" | "enabled">>): void;
}

export interface ChannelAdapter {
  readonly kind: ChannelConfig["kind"];
  readonly meta: ChannelAdapterMeta;
  start(ctx: ChannelAdapterContext): Promise<void>;
  stop(): Promise<void>;
  send(target: ChannelTarget, message: ChannelOutbound): Promise<SendResult>;
  handleWebhook?(request: WebhookRequest): Promise<WebhookResult>;
}

export interface ChannelAdapterEntry {
  meta: ChannelAdapterMeta;
  create(config: ChannelConfig): ChannelAdapter;
}
