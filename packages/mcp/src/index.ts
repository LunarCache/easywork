// @ew/mcp — MCP 客户端（stdio + HTTP），作为 ToolProvider 接入 agent。
export { McpClientManager, type McpClientManagerDeps } from "./manager.js";
export {
  realConnect,
  type ConnectFn,
  type McpConnection,
  type McpToolSpec,
  type McpContentPart,
} from "./connect.js";
