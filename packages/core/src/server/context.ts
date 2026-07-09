import type { FastifyInstance } from "fastify";
import type { SkillManager } from "@ew/skills";
import type { ChannelGateway } from "@ew/im-connectors";
import type { LocalMemoryProvider } from "@ew/memory";
import type { McpClientManager } from "@ew/mcp";
import type { EngineRegistry } from "../engine/registry.js";
import type { LocalBackend } from "../engine/local-backend.js";
import type { ModelManager } from "../models/manager.js";
import type { ProviderManager } from "../providers/manager.js";
import type { SessionHost } from "../agent/session-host.js";
import type { SqliteConversationRepo } from "../store/conversation.js";
import type { EmbeddingService } from "../memory/embedding-service.js";
import type { KnowledgeBaseStore } from "../rag/store.js";
import type { InboxEvent } from "@ew/shared";

export interface CoreHttpContext {
  app: FastifyInstance;
  registry: EngineRegistry;
  local: LocalBackend;
  models: ModelManager;
  providers: ProviderManager;
  sessionHost: SessionHost;
  skills: SkillManager;
  skillsDir: string;
  mcp: McpClientManager;
  channels: ChannelGateway;
  memory: LocalMemoryProvider;
  embeddings: EmbeddingService;
  kb: KnowledgeBaseStore;
  repo: SqliteConversationRepo;
  fetchImpl: typeof fetch;
  persistProviders(): void;
  persistChannels(): void;
  emitInboxChanged(patch: Omit<Extract<InboxEvent, { type: "changed" }>, "type" | "at">): void;
  inboxSubscribers: Set<(event: InboxEvent) => void>;
}
