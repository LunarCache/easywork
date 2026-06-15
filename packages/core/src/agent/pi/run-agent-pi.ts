// pi 版 agent runner：用 @earendil-works/pi-agent-core 的 agentLoop 驱动一轮 agent 运行，
// 在边界把 pi 事件映射回我们的 AgentEvent（UI/SDK 不变），审批走 pi 的 beforeToolCall 钩子。
import { agentLoop } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai";
import {
  needsApproval,
  type AgentEvent,
  type AgentRunInput,
  type ApprovalGate,
  type MemoryProvider,
  type Tool,
} from "@ew/shared";
import { ewHistoryToPi } from "./message-map.js";
import { PiEventMapper } from "./event-map.js";
import { toPiTool, type BaseToolCtx } from "./tool-adapter.js";
import type { ResolvedPiModel } from "../../ai/pi-models.js";

export interface RunAgentPiDeps {
  /** model id → pi-ai Model + apiKey（resolvePiModel 包装）。 */
  resolveModel(modelId: string): ResolvedPiModel;
  /** 本轮可用工具（我们的 Tool[]，已含 builtin/MCP/skills/extra/workspace）。 */
  tools: Tool[];
  approval: ApprovalGate;
  workspaceDir: string;
  memory?: MemoryProvider;
  /** 标记为写类、需串行执行的工具名（防并发写竞态）。 */
  mutatingTools?: Set<string>;
  /** 注入 streamFn（测试用）；默认 pi-ai streamSimple。 */
  streamFn?: typeof streamSimple;
}

export async function* runAgentPi(input: AgentRunInput, deps: RunAgentPiDeps): AsyncIterable<AgentEvent> {
  let resolved: ResolvedPiModel;
  try {
    resolved = deps.resolveModel(input.model);
  } catch (e) {
    yield { type: "error", message: e instanceof Error ? e.message : String(e) };
    return;
  }

  const { systemPrompt, messages } = ewHistoryToPi(input.history, input.model);
  // 末条 user 作为本轮 prompt，其余作为已有上下文。
  let prompts = messages.slice();
  let contextMessages: typeof messages = [];
  if (prompts.length > 0 && prompts[prompts.length - 1]!.role === "user") {
    contextMessages = prompts.slice(0, -1);
    prompts = [prompts[prompts.length - 1]!];
  } else {
    contextMessages = prompts;
    prompts = [];
  }

  const baseCtx: BaseToolCtx = {
    sessionId: input.threadId,
    workspaceDir: deps.workspaceDir,
    approval: deps.approval,
  };
  const byName = new Map(deps.tools.map((t) => [t.definition.name, t]));
  const piTools = deps.tools.map((t) =>
    toPiTool(t, baseCtx, deps.mutatingTools?.has(t.definition.name) ? { executionMode: "sequential" } : undefined),
  );

  // 审批：pi 在执行工具前调 beforeToolCall；映射到我们的 ApprovalGate。
  const usedTools = new Set<string>();
  const approvedAlways = new Set<string>();
  const beforeToolCall = async (ctx: {
    toolCall: { name: string };
    args: unknown;
  }): Promise<{ block: boolean; reason?: string } | undefined> => {
    const tool = byName.get(ctx.toolCall.name);
    if (!tool) return undefined;
    const firstUse = !usedTools.has(ctx.toolCall.name) && !approvedAlways.has(ctx.toolCall.name);
    usedTools.add(ctx.toolCall.name);
    if (!needsApproval(tool.requiresApproval, ctx.args, firstUse)) return undefined;
    if (approvedAlways.has(ctx.toolCall.name)) return undefined;
    const verdict = await deps.approval.request({ toolName: ctx.toolCall.name, args: ctx.args });
    if (verdict === "deny") return { block: true, reason: "用户拒绝执行该工具" };
    if (verdict === "approve-always") approvedAlways.add(ctx.toolCall.name);
    return undefined;
  };

  const config = {
    model: resolved.model,
    ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
    convertToLlm: (m: typeof messages) => m,
    beforeToolCall: beforeToolCall as never,
    toolExecutionMode: "parallel" as const,
  };
  const context = { systemPrompt, messages: contextMessages, tools: piTools };

  const mapper = new PiEventMapper();
  const stream = agentLoop(prompts as never, context as never, config as never, input.signal, deps.streamFn ?? streamSimple);
  try {
    for await (const ev of stream) {
      for (const out of mapper.map(ev)) yield out;
    }
  } catch (e) {
    yield { type: "error", message: e instanceof Error ? e.message : String(e) };
  }

  // 收尾：记忆抽取（失败不阻断）。
  if (deps.memory) {
    await deps.memory
      .observe({ messages: input.history, sessionId: input.threadId, model: input.model })
      .catch(() => {});
  }
}
