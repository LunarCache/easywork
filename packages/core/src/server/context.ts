import type { FastifyInstance } from "fastify";
import type { SkillManager } from "@ew/skills";
import type { ChannelGateway } from "@ew/im-connectors";
import type { AdditiveMemoryProvider, LocalMemoryProvider } from "@ew/memory";
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
import type { SkillCandidateLifecycle } from "../skill-learning/candidate-service.js";
import type { SourceConversationLifecycle } from "../conversations/source-conversation-lifecycle.js";

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
  skillLifecycle: SkillCandidateLifecycle;
  mcp: McpClientManager;
  channels: ChannelGateway;
  channelOps: ChannelOperations;
  memory: LocalMemoryProvider;
  /** Agent/渠道实际使用的记忆视图：本地 Core Memory + 可禁用的只读外部召回。 */
  agentMemory: AdditiveMemoryProvider;
  embeddings: EmbeddingService;
  repo: SqliteConversationRepo;
  sourceConversations: SourceConversationLifecycle;
  fetchImpl: typeof fetch;
  persistProviders(): void;
  persistMcp(): void;
}
