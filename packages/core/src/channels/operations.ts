import { randomUUID } from "node:crypto";
import type {
  AgentEvent,
  AgentRunInput,
  ChannelConfig,
  ChannelConnectorView,
  ChannelStatus,
  ConversationRepo,
  InboxEvent,
  StoredMessage,
  Thread,
} from "@ew/shared";
import { messageText } from "@ew/shared";
import {
  ChannelGateway,
  ConnectorHost,
  type ChannelAdapterRegistry,
  type WebhookRequest,
  type WebhookResult,
  type registerFeishuApp,
  type registerWechatAccount,
} from "@ew/im-connectors";
import type { ChannelSecretStore } from "./secret-store.js";

export interface FeishuSetupInput {
  id?: string;
  displayName?: string;
  enabled: boolean;
  region: "feishu" | "lark";
  auth?: ChannelConfig["auth"];
}

export interface WechatSetupInput {
  id?: string;
  displayName?: string;
  enabled: boolean;
  auth?: ChannelConfig["auth"];
}

type SetupStatus = "initializing" | "waiting" | "completed" | "error" | "aborted";

interface SetupSessionBase {
  id: string;
  connectorId: string;
  displayName?: string;
  status: SetupStatus;
  createdAt: string;
  qrUrl?: string;
  expireAt?: string;
  statusDetail?: string;
  error?: string;
  channelStatus?: ChannelStatus;
  abort: AbortController;
}

type FeishuSetupSession = SetupSessionBase;
type WechatSetupSession = SetupSessionBase;

export interface ChannelSetupView {
  id: string;
  connectorId: string;
  displayName?: string;
  status: SetupStatus;
  createdAt: string;
  qrUrl?: string;
  expireAt?: string;
  statusDetail?: string;
  error?: string;
  channelStatus?: ChannelStatus;
}

export interface InboxThreadSummary {
  id: string;
  title: string;
  channel: NonNullable<Thread["channel"]>;
  projectId?: string;
  modelId: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastMessage?: {
    role: StoredMessage["role"];
    text: string;
    createdAt: string;
  };
}

export interface ChannelOperationsDeps {
  registry: ChannelAdapterRegistry;
  configs: ChannelConfig[];
  repo: ConversationRepo & { nextSeq?(threadId: string): number };
  defaultModel?: string;
  run(input: AgentRunInput): AsyncIterable<AgentEvent>;
  persistConfigs(configs: ChannelConfig[]): void;
  secretStore: ChannelSecretStore;
  feishuRegister: typeof registerFeishuApp;
  wechatRegister: typeof registerWechatAccount;
}

export class ChannelOperations {
  readonly gateway: ChannelGateway;
  private readonly host: ConnectorHost;
  private readonly inboxSubscribers = new Set<(event: InboxEvent) => void>();
  private readonly feishuSetupSessions = new Map<string, FeishuSetupSession>();
  private readonly wechatSetupSessions = new Map<string, WechatSetupSession>();

  constructor(private readonly deps: ChannelOperationsDeps) {
    this.host = new ConnectorHost({
      repo: deps.repo,
      defaultModel: deps.defaultModel ?? "",
      run: deps.run,
      onMessagePersisted: (info) => {
        this.emitInboxChanged({
          reason: "message",
          threadId: info.threadId,
          channel: info.channel,
        });
      },
    });
    this.gateway = new ChannelGateway({
      registry: deps.registry,
      configs: deps.configs,
      handleInbound: async (message, adapter) => {
        await this.host.handleInbound(adapter, message);
      },
    });
  }

  adapters() {
    return this.gateway.metas();
  }

  connectors() {
    return {
      connectors: this.gateway.configs().map(toChannelConnectorView),
      status: this.gateway.statuses(),
    };
  }

  async upsertConnector(config: ChannelConfig): Promise<ChannelStatus> {
    const previousSecrets = this.deps.secretStore.get(config.id);
    const incomingSecrets = nonEmptySecrets(config.secrets);
    const secrets = { ...previousSecrets, ...incomingSecrets };
    if (Object.keys(secrets).length) this.deps.secretStore.set(config.id, secrets);
    const hydrated = { ...config, secrets };
    let status: ChannelStatus;
    try {
      status = await this.gateway.upsert(hydrated);
    } catch (error) {
      if (Object.keys(previousSecrets).length) this.deps.secretStore.set(config.id, previousSecrets);
      else this.deps.secretStore.delete(config.id);
      throw error;
    }
    this.persistConnectors();
    if (hydrated.enabled) status = await this.gateway.start(hydrated.id);
    this.emitInboxChanged({ reason: "connector" });
    return status;
  }

  async startConnector(id: string): Promise<ChannelStatus> {
    const status = await this.gateway.start(id);
    this.emitInboxChanged({ reason: "status" });
    return status;
  }

  async stopConnector(id: string): Promise<ChannelStatus> {
    const status = await this.gateway.stop(id);
    this.emitInboxChanged({ reason: "status" });
    return status;
  }

  async deleteConnector(id: string): Promise<boolean> {
    this.deps.secretStore.delete(id);
    const removed = await this.gateway.remove(id);
    this.persistConnectors();
    this.emitInboxChanged({ reason: "connector" });
    return removed;
  }

  handleWebhook(id: string, req: WebhookRequest): Promise<WebhookResult> {
    return this.gateway.handleWebhook(id, req);
  }

  startAll(): Promise<void> {
    return this.gateway.startAll();
  }

  async stopAll(): Promise<void> {
    this.abortSetupSessions();
    await this.gateway.stopAll();
  }

  subscribeInbox(send: (event: InboxEvent) => void): () => void {
    this.inboxSubscribers.add(send);
    send({ type: "ready", at: new Date().toISOString() });
    return () => {
      this.inboxSubscribers.delete(send);
    };
  }

  listInboxThreads(): InboxThreadSummary[] {
    return this.deps.repo
      .listThreads()
      .filter((thread) => thread.channel)
      .map((thread) => {
        const history = this.deps.repo.history(thread.id);
        const last = [...history].reverse().find((message) => messageText(message.parts).trim());
        return {
          id: thread.id,
          title: thread.title,
          channel: thread.channel!,
          ...(thread.projectId ? { projectId: thread.projectId } : {}),
          modelId: thread.modelId,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
          messageCount: history.length,
          ...(last
            ? {
                lastMessage: {
                  role: last.role,
                  text: messageText(last.parts).trim(),
                  createdAt: last.createdAt,
                },
              }
            : {}),
        };
      });
  }

  async startFeishuSetup(input: FeishuSetupInput): Promise<ChannelSetupView> {
    const sessionId = randomUUID();
    const connectorId = input.id?.trim() || `feishu-${sessionId.slice(0, 8)}`;
    const abort = new AbortController();
    const session: FeishuSetupSession = {
      id: sessionId,
      connectorId,
      ...(input.displayName ? { displayName: input.displayName } : {}),
      status: "initializing",
      createdAt: new Date().toISOString(),
      abort,
    };
    this.feishuSetupSessions.set(sessionId, session);

    let resolveQr: (() => void) | undefined;
    let rejectQr: ((err: Error) => void) | undefined;
    const qrReady = new Promise<void>((resolve, reject) => {
      resolveQr = resolve;
      rejectQr = reject;
    });

    void this.deps.feishuRegister({
      region: input.region,
      signal: abort.signal,
      onQRCodeReady: (info) => {
        session.status = "waiting";
        session.qrUrl = info.url;
        session.expireAt = new Date(Date.now() + info.expireIn * 1000).toISOString();
        resolveQr?.();
      },
      onStatusChange: (info) => {
        session.statusDetail = info.status;
      },
    }).then(async (result) => {
      if (abort.signal.aborted || session.status === "aborted") {
        session.status = "aborted";
        this.scheduleFeishuSetupCleanup(sessionId);
        return;
      }
      const config: ChannelConfig = {
        id: connectorId,
        kind: "feishu",
        enabled: input.enabled,
        ...(input.displayName ? { displayName: input.displayName } : {}),
        secrets: { appId: result.appId, appSecret: result.appSecret },
        options: {
          transport: "websocket",
          domain: result.tenantBrand ?? input.region,
          receiveIdType: "chat_id",
        },
        auth: input.auth ?? { allowAll: true },
      };
      const status = await this.upsertConnector(config);
      session.status = "completed";
      session.channelStatus = status;
      this.scheduleFeishuSetupCleanup(sessionId);
    }).catch((err) => {
      session.status = abort.signal.aborted ? "aborted" : "error";
      session.error = err instanceof Error ? err.message : String(err);
      rejectQr?.(err instanceof Error ? err : new Error(String(err)));
      this.scheduleFeishuSetupCleanup(sessionId);
    });

    await Promise.race([
      qrReady.catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 10_000)),
    ]);
    return serializeSetup(session);
  }

  getFeishuSetup(id: string): ChannelSetupView | undefined {
    const session = this.feishuSetupSessions.get(id);
    return session ? serializeSetup(session) : undefined;
  }

  cancelFeishuSetup(id: string): void {
    const session = this.feishuSetupSessions.get(id);
    if (!session || !isActiveSetup(session)) return;
    session.abort.abort();
    session.status = "aborted";
    this.scheduleFeishuSetupCleanup(session.id);
  }

  async startWechatSetup(input: WechatSetupInput): Promise<ChannelSetupView> {
    const sessionId = randomUUID();
    const connectorId = input.id?.trim() || `wechat-${sessionId.slice(0, 8)}`;
    const abort = new AbortController();
    const session: WechatSetupSession = {
      id: sessionId,
      connectorId,
      ...(input.displayName ? { displayName: input.displayName } : {}),
      status: "initializing",
      createdAt: new Date().toISOString(),
      abort,
    };
    this.wechatSetupSessions.set(sessionId, session);

    let resolveQr: (() => void) | undefined;
    let rejectQr: ((err: Error) => void) | undefined;
    const qrReady = new Promise<void>((resolve, reject) => {
      resolveQr = resolve;
      rejectQr = reject;
    });

    void this.deps.wechatRegister({
      signal: abort.signal,
      onQRCodeReady: (info) => {
        session.status = "waiting";
        session.qrUrl = info.url;
        session.expireAt = new Date(Date.now() + info.expireIn * 1000).toISOString();
        resolveQr?.();
      },
      onStatusChange: (info) => {
        session.statusDetail = info.status;
      },
    }).then(async (result) => {
      if (abort.signal.aborted || session.status === "aborted") {
        session.status = "aborted";
        this.scheduleWechatSetupCleanup(sessionId);
        return;
      }
      const config: ChannelConfig = {
        id: connectorId,
        kind: "wechat",
        enabled: input.enabled,
        ...(input.displayName ? { displayName: input.displayName } : {}),
        secrets: { token: result.token },
        options: {
          accountId: result.accountId,
          baseUrl: result.baseUrl,
          ...(result.userId ? { userId: result.userId } : {}),
          groupPolicy: "disabled",
        },
        auth: input.auth ?? { allowAll: true },
      };
      const status = await this.upsertConnector(config);
      session.status = "completed";
      session.channelStatus = status;
      this.scheduleWechatSetupCleanup(sessionId);
    }).catch((err) => {
      session.status = abort.signal.aborted ? "aborted" : "error";
      session.error = err instanceof Error ? err.message : String(err);
      rejectQr?.(err instanceof Error ? err : new Error(String(err)));
      this.scheduleWechatSetupCleanup(sessionId);
    });

    await Promise.race([
      qrReady.catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 10_000)),
    ]);
    return serializeSetup(session);
  }

  getWechatSetup(id: string): ChannelSetupView | undefined {
    const session = this.wechatSetupSessions.get(id);
    return session ? serializeSetup(session) : undefined;
  }

  cancelWechatSetup(id: string): void {
    const session = this.wechatSetupSessions.get(id);
    if (!session || !isActiveSetup(session)) return;
    session.abort.abort();
    session.status = "aborted";
    this.scheduleWechatSetupCleanup(session.id);
  }

  abortSetupSessions(): void {
    for (const session of this.feishuSetupSessions.values()) {
      if (isActiveSetup(session)) {
        session.abort.abort();
        session.status = "aborted";
      }
    }
    for (const session of this.wechatSetupSessions.values()) {
      if (isActiveSetup(session)) {
        session.abort.abort();
        session.status = "aborted";
      }
    }
  }

  private persistConnectors(): void {
    this.deps.persistConfigs(this.gateway.configs().map(stripChannelSecrets));
  }

  private emitInboxChanged(patch: Omit<Extract<InboxEvent, { type: "changed" }>, "type" | "at">): void {
    if (!this.inboxSubscribers.size) return;
    const event: InboxEvent = { type: "changed", at: new Date().toISOString(), ...patch };
    for (const send of [...this.inboxSubscribers]) send(event);
  }

  private scheduleFeishuSetupCleanup(id: string): void {
    setTimeout(() => this.feishuSetupSessions.delete(id), 10 * 60 * 1000).unref?.();
  }

  private scheduleWechatSetupCleanup(id: string): void {
    setTimeout(() => this.wechatSetupSessions.delete(id), 10 * 60 * 1000).unref?.();
  }
}

function nonEmptySecrets(secrets: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(secrets)) {
    if (value) out[key] = value;
  }
  return out;
}

export function stripChannelSecrets(config: ChannelConfig): ChannelConfig {
  return {
    ...config,
    secrets: {},
  };
}

export function toChannelConnectorView(config: ChannelConfig): ChannelConnectorView {
  return {
    ...stripChannelSecrets(config),
    secretKeys: Object.keys(nonEmptySecrets(config.secrets)).sort(),
  };
}

function isActiveSetup(session: SetupSessionBase): boolean {
  return session.status === "initializing" || session.status === "waiting";
}

function serializeSetup(session: SetupSessionBase): ChannelSetupView {
  return {
    id: session.id,
    connectorId: session.connectorId,
    ...(session.displayName ? { displayName: session.displayName } : {}),
    status: session.status,
    createdAt: session.createdAt,
    ...(session.qrUrl ? { qrUrl: session.qrUrl } : {}),
    ...(session.expireAt ? { expireAt: session.expireAt } : {}),
    ...(session.statusDetail ? { statusDetail: session.statusDetail } : {}),
    ...(session.error ? { error: session.error } : {}),
    ...(session.channelStatus ? { channelStatus: session.channelStatus } : {}),
  };
}
