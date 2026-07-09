import { describe, expect, it } from "vitest";
import {
  ChannelAdapterRegistry,
  type ChannelAdapter,
  type ChannelAdapterContext,
  type SendResult,
} from "@ew/im-connectors";
import type { ChannelOutbound, ChannelTarget } from "@ew/shared";
import { ChannelOperations } from "../src/channels/operations.js";
import { SqliteConversationRepo } from "../src/store/conversation.js";

const telegramMeta = {
  kind: "telegram",
  label: "Test Telegram",
  requiredSecrets: [],
} as const;

class TestAdapter implements ChannelAdapter {
  readonly kind = "telegram";
  readonly meta = telegramMeta;

  async start(ctx: ChannelAdapterContext): Promise<void> {
    ctx.setStatus({ lastInboundAt: "2026-01-01T00:00:00.000Z" });
  }

  async stop(): Promise<void> {}

  async send(_target: ChannelTarget, _message: ChannelOutbound): Promise<SendResult> {
    return { ok: true };
  }
}

function makeOperations(repo: SqliteConversationRepo, overrides: Partial<ConstructorParameters<typeof ChannelOperations>[0]> = {}) {
  const registry = new ChannelAdapterRegistry();
  registry.register({
    meta: telegramMeta,
    create: () => new TestAdapter(),
  });
  return new ChannelOperations({
    registry,
    configs: [],
    repo,
    run: async function* () {},
    persistConfigs: () => {},
    feishuRegister: async () => {
      throw new Error("unused_feishu_register");
    },
    wechatRegister: async () => {
      throw new Error("unused_wechat_register");
    },
    ...overrides,
  });
}

describe("ChannelOperations", () => {
  it("persists connector lifecycle changes and emits inbox invalidations", async () => {
    const repo = new SqliteConversationRepo(":memory:");
    const persisted: unknown[] = [];
    const events: unknown[] = [];
    try {
      const ops = makeOperations(repo, {
        persistConfigs: (configs) => persisted.push(configs),
      });
      const unsubscribe = ops.subscribeInbox((event) => events.push(event));

      const status = await ops.upsertConnector({
        id: "tg-main",
        kind: "telegram",
        enabled: false,
        secrets: { token: "test-token" },
        options: {},
        auth: { allowAll: true },
      });

      expect(status).toMatchObject({ id: "tg-main", kind: "telegram", running: false });
      expect(persisted).toEqual([
        [
          expect.objectContaining({
            id: "tg-main",
            kind: "telegram",
            secrets: { token: "test-token" },
          }),
        ],
      ]);
      expect(events).toEqual([
        expect.objectContaining({ type: "ready" }),
        expect.objectContaining({ type: "changed", reason: "connector" }),
      ]);
      unsubscribe();
    } finally {
      repo.close();
    }
  });

  it("projects channel threads into the inbox read model", () => {
    const repo = new SqliteConversationRepo(":memory:");
    try {
      const ops = makeOperations(repo);
      const channelThread = repo.resolveThreadForChannel("wechat", "wxid_alice", { modelId: "model-a" });
      repo.appendMessage({
        id: "msg-channel-1",
        threadId: channelThread.id,
        role: "user",
        seq: 0,
        parts: [{ type: "text", text: "来自微信的消息" }],
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      const plainThread = repo.createThread({ id: "plain-chat", title: "普通对话", modelId: "model-a" });
      repo.appendMessage({
        id: "msg-plain-1",
        threadId: plainThread.id,
        role: "user",
        seq: 0,
        parts: [{ type: "text", text: "普通聊天消息" }],
        createdAt: "2026-01-01T00:01:00.000Z",
      });

      expect(ops.listInboxThreads()).toMatchObject([
        {
          id: channelThread.id,
          title: "wechat:wxid_alice",
          channel: { kind: "wechat", channelId: "wxid_alice" },
          messageCount: 1,
          lastMessage: { role: "user", text: "来自微信的消息" },
        },
      ]);
    } finally {
      repo.close();
    }
  });

  it("keeps canceled Feishu setup sessions from creating connectors", async () => {
    const repo = new SqliteConversationRepo(":memory:");
    let resolveRegister!: (value: { appId: string; appSecret: string; tenantBrand: "feishu" }) => void;
    try {
      const ops = makeOperations(repo, {
        feishuRegister: async (options) => {
          options.onQRCodeReady({ url: "https://accounts.feishu.cn/qr/test", expireIn: 600 });
          return await new Promise((resolve) => {
            resolveRegister = resolve;
          });
        },
      });

      const session = await ops.startFeishuSetup({
        id: "fs-canceled",
        displayName: "Canceled bot",
        enabled: false,
        region: "feishu",
      });
      expect(session.status).toBe("waiting");

      ops.cancelFeishuSetup(session.id);
      resolveRegister({ appId: "cli_canceled", appSecret: "canceled-secret", tenantBrand: "feishu" });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(ops.getFeishuSetup(session.id)).toMatchObject({ status: "aborted" });
      expect(ops.connectors().connectors).toEqual([]);
    } finally {
      repo.close();
    }
  });
});
