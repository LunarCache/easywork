import {
  DefaultResourceLoader,
  type ToolDefinition as PiToolDefinition,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import type { ConversationRepo, MemoryProvider, Tool } from "@ew/shared";
import type { McpClientManager } from "@ew/mcp";
import type { KnowledgeBaseStore } from "../rag/store.js";
import {
  buildEwCustomTools,
  memoryExtensionFactory,
  permissionExtensionFactory,
  type RunRuntime,
} from "./ew-extensions.js";

interface AgentSessionResourceDeps {
  agentDir: string;
  globalSkillPaths?: string[];
  memory?: MemoryProvider;
  repo?: ConversationRepo;
  kb?: KnowledgeBaseStore;
  mcp?: McpClientManager;
  builtins?: Tool[];
  noteMemoryTurn: (
    threadId: string,
    memoryScope: string,
    modelId: string,
    conv: { role: string; content: string }[],
  ) => void;
}

interface AgentSessionResourceInput {
  threadId: string;
  modelId: string;
  cwd: string;
  memoryScope: string;
  excludeSkills: string[];
  excludeTools: string[];
}

export interface AgentSessionResources {
  runtime: RunRuntime;
  resourceLoader: DefaultResourceLoader;
  customTools: PiToolDefinition[];
  excludeSkillsKey: string;
  excludeToolsKey: string;
}

export function agentSessionResourceKey(excludeSkills: string[]): string {
  return excludeSkills.slice().sort().join(",");
}

/**
 * Agent Runtime 的 resource discovery seam：集中 Skill 发现、扩展工厂、权限 runtime、
 * 以及 EasyWork customTools 装配。SessionHost 只消费生成好的 resources。
 */
export async function buildAgentSessionResources(
  deps: AgentSessionResourceDeps,
  input: AgentSessionResourceInput,
): Promise<AgentSessionResources> {
  const runtime: RunRuntime = { mode: "approve-each", alwaysApproved: new Set() };
  const factories: ExtensionFactory[] = [];
  if (deps.memory) {
    factories.push(
      memoryExtensionFactory({
        memory: deps.memory,
        scope: input.memoryScope,
        runtime,
        onTurn: (conv) => deps.noteMemoryTurn(input.threadId, input.memoryScope, input.modelId, conv),
      }),
    );
  }

  // 权限/路径限定扩展：始终装载，escapesCwd 硬隔离 fs 工具；bash 由审批把守。
  factories.push(permissionExtensionFactory(runtime, input.cwd));

  const excluded = new Set(input.excludeSkills);
  const resourceLoader = new DefaultResourceLoader({
    cwd: input.cwd,
    agentDir: deps.agentDir,
    extensionFactories: factories,
    ...(deps.globalSkillPaths?.length ? { additionalSkillPaths: deps.globalSkillPaths } : {}),
    ...(excluded.size
      ? { skillsOverride: (base) => ({ ...base, skills: base.skills.filter((s) => !excluded.has(s.name)) }) }
      : {}),
  });
  await resourceLoader.reload();

  const excludedTools = new Set(input.excludeTools);
  const customTools = (await buildEwCustomTools({
    sessionId: input.threadId,
    cwd: input.cwd,
    memoryScope: input.memoryScope,
    ...(deps.memory ? { memory: deps.memory } : {}),
    ...(deps.repo ? { repo: deps.repo } : {}),
    ...(deps.kb ? { kb: deps.kb } : {}),
    ...(deps.mcp ? { mcp: deps.mcp } : {}),
    ...(deps.builtins ? { builtins: deps.builtins } : {}),
  })).filter((tool) => !excludedTools.has(tool.name));

  return {
    runtime,
    resourceLoader,
    customTools,
    excludeSkillsKey: agentSessionResourceKey(input.excludeSkills),
    excludeToolsKey: agentSessionResourceKey(input.excludeTools),
  };
}
