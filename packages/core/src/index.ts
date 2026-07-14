// @ew/core — 核心守护进程库。被 @ew/daemon（CLI）与 @ew/desktop（Electron）共同消费。
export { createCore, type CoreServer, type CreateCoreOptions } from "./server/app.js";
export { EngineRegistry } from "./engine/registry.js";
export { RouterServerManager } from "./engine/router-server-manager.js";
export { getFreePort, type LocalEndpoint } from "./engine/net.js";
export type { LocalBackend } from "./engine/local-backend.js";
export { dataDir, modelsDir, memoryDir, dbPath } from "./config/paths.js";

// 模型管理
export { ModelManager, type ModelManagerOptions } from "./models/manager.js";
export { LocalModelSettingsStore } from "./models/local-model-settings.js";
export {
  createChannelSecretStore,
  MemoryChannelSecretStore,
  type ChannelSecretStore,
} from "./channels/secret-store.js";
export { HFClient, groupVariants, type HFFile } from "./models/hf.js";
export { downloadVariant, enumerateShards } from "./models/download.js";
export { parseGGUFBuffer, readGGUFHeader, type GGUFMetadata } from "./models/gguf.js";

// 云端 provider
export { ProviderManager, type CloudProviderConfig } from "./providers/manager.js";
export {
  ProviderCatalog,
  normalizeProviderConfig,
  runtimeModelForProviderConfig,
  runtimeModelsForProviderConfig,
} from "./providers/catalog.js";
export type { ProviderCatalogInfo, ProviderCatalogItem, ProviderCatalogModel } from "./providers/catalog.js";

// OpenAI 兼容转换（供测试/复用）
export {
  openaiToChatRequest,
  chatResponseToOpenAI,
  streamEventToOpenAIChunks,
} from "./openai-compat/translate.js";

// Agent（pi-coding-agent 托管内核）
export { SessionHost, type SessionHostDeps, type EwAgentRunInput } from "./agent/session-host.js";

// 会话存储 + 记忆 embedding
export { SqliteConversationRepo } from "./store/conversation.js";
export { EmbeddingService, type EmbeddingServiceDeps } from "./memory/embedding-service.js";
