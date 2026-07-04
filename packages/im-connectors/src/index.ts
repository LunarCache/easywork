// @ew/im-connectors — 渠道连接器抽象 + 宿主路由 + 具体连接器。
// 已实现：Telegram（HTTP long-poll）、Feishu/Lark（WebSocket 默认 + webhook 高级模式）。
export type {
  ChannelAdapter,
  ChannelAdapterContext,
  ChannelAdapterEntry,
  SendResult,
  WebhookRequest,
  WebhookResult,
} from "./adapter.js";
export { ChannelGateway, type ChannelGatewayDeps } from "./gateway.js";
export { ConnectorHost, type ConnectorHostDeps } from "./host.js";
export { ChannelAdapterRegistry, channelAdapterRegistry, registerBuiltInChannelAdapters } from "./registry.js";
export {
  FeishuChannelAdapter,
  calculateFeishuSignature,
  decryptFeishuEvent,
  feishuAdapterEntry,
  registerFeishuApp,
  type FeishuOptions,
  type FeishuRegistrationOptions,
  type FeishuRegistrationResult,
  type FeishuReceiveIdType,
  type FeishuTransport,
} from "./feishu.js";
export {
  TelegramChannelAdapter,
  TelegramConnector,
  telegramAdapterEntry,
  type TelegramOptions,
} from "./telegram.js";
