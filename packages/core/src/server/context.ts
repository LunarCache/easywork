import type { FastifyInstance } from "fastify";
import type { SkillManager } from "@ew/skills";
import type { ChannelGateway } from "@ew/im-connectors";
import type { LocalMemoryProvider } from "@ew/memory";
import type { McpClientManager } from "@ew/mcp";
import type { ChannelOperations } from "../channels/operations.js";
import type { EngineRegistry } from "../engine/registry.js";
import type { LocalBackend } from "../engine/local-backend.js";
import type { ModelManager } from "../models/manager.js";
import type { LocalModelSettingsStore } from "../models/local-model-settings.js";
import type { ProviderManager } from "../providers/manager.js";
import type { SessionHost } from "../agent/session-host.js";
import type { SqliteConversationRepo } from "../store/conversation.js";
import type { EmbeddingService } from "../memory/embedding-service.js";
import type { KnowledgeBaseStore } from "../rag/store.js";

export interface CoreHttpContext {
  app: FastifyInstance;
  registry: EngineRegistry;
  local: LocalBackend;
  models: ModelManager;
  localModelSettings: LocalModelSettingsStore;
  providers: ProviderManager;
  sessionHost: SessionHost;
  skills: SkillManager;
  skillsDir: string;
  mcp: McpClientManager;
  channels: ChannelGateway;
  channelOps: ChannelOperations;
  memory: LocalMemoryProvider;
  embeddings: EmbeddingService;
  kb: KnowledgeBaseStore;
  repo: SqliteConversationRepo;
  fetchImpl: typeof fetch;
  persistProviders(): void;
  persistMcp(): void;
}
