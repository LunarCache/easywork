// @ew/im-connectors — 渠道连接器抽象 + 宿主路由 + 具体连接器。
// 已实现：Telegram（HTTP）。WeCom/Feishu/Discord 待补（Discord 需 gateway websocket）。
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
  TelegramChannelAdapter,
  TelegramConnector,
  telegramAdapterEntry,
  type TelegramOptions,
} from "./telegram.js";
