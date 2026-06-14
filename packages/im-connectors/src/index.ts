// @ew/im-connectors — 渠道连接器抽象 + 宿主路由 + 具体连接器。
// 已实现：Telegram（HTTP）。WeCom/Feishu/Discord 待补（Discord 需 gateway websocket）。
export { ConnectorHost, type ConnectorHostDeps } from "./host.js";
export { TelegramConnector, type TelegramOptions } from "./telegram.js";
