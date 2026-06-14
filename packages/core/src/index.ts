// @ew/core — 核心守护进程库。被 @ew/daemon（CLI）与 @ew/desktop（Electron）共同消费。
export { createCore, type CoreServer, type CreateCoreOptions } from "./server/app.js";
export { EngineRegistry } from "./engine/registry.js";
export { LocalServerManager, getFreePort } from "./engine/local-server-manager.js";
export { dataDir, modelsDir, memoryDir, dbPath } from "./config/paths.js";

// 模型管理
export { ModelManager, type ModelManagerOptions } from "./models/manager.js";
export { HFClient, groupVariants, type HFFile } from "./models/hf.js";
export { downloadVariant, enumerateShards } from "./models/download.js";
export { parseGGUFBuffer, readGGUFHeader, type GGUFMetadata } from "./models/gguf.js";

// 云端 provider
export { ProviderManager, type CloudProviderConfig } from "./providers/manager.js";

// OpenAI 兼容转换（供测试/复用）
export {
  openaiToChatRequest,
  chatResponseToOpenAI,
  streamEventToOpenAIChunks,
} from "./openai-compat/translate.js";

// Agent
export { runAgent, type AgentDeps } from "./agent/loop.js";
export { ToolRegistry } from "./agent/tool-registry.js";
export { parseToolCallsFromText, stripToolCallMarkup } from "./agent/healing.js";
export { AutoApproveGate } from "./agent/approval.js";

// 会话存储 + 记忆 embedding
export { SqliteConversationRepo } from "./store/conversation.js";
export { EmbeddingService, type EmbeddingServiceDeps } from "./memory/embedding-service.js";
