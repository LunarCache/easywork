import {
  canonicalToolCallKey,
  messageText,
  needsApproval,
  type AgentEvent,
  type AgentRunInput,
  type ApprovalGate,
  type ChatMessage,
  type InferenceEngine,
  type MemoryProvider,
  type Tool,
  type ToolCall,
  type ToolExecContext,
  type ToolResult,
} from "@ew/shared";
import { parseToolCallsFromText, stripToolCallMarkup } from "./healing.js";
import type { ToolRegistry } from "./tool-registry.js";

const OPENERS = ["<tool_call>", "<function="];
const MAX_OPENER = Math.max(...OPENERS.map((o) => o.length));

/**
 * 尾缓冲剥离器：流式累积文本，输出"安全"可见文本，
 * 绝不吐出半个 <tool_call>/<function= 标签。
 */
class TailStripper {
  private buffer = "";
  private emitted = "";

  push(delta: string): string {
    this.buffer += delta;
    const safe = stripToolCallMarkup(this.buffer, { final: false });
    // 截到第一个未闭合 opener 之前。
    let cut = safe.length;
    for (const o of OPENERS) {
      const i = safe.indexOf(o);
      if (i >= 0) cut = Math.min(cut, i);
    }
    let emittable = safe.slice(0, cut);
    // 末尾可能是某个 opener 的前缀 → 暂时扣住。
    for (let k = Math.min(MAX_OPENER - 1, emittable.length); k >= 1; k--) {
      const suffix = emittable.slice(-k);
      if (OPENERS.some((o) => o.startsWith(suffix))) {
        emittable = emittable.slice(0, emittable.length - k);
        break;
      }
    }
    if (emittable.length > this.emitted.length && emittable.startsWith(this.emitted)) {
      const out = emittable.slice(this.emitted.length);
      this.emitted = emittable;
      return out;
    }
    return "";
  }

  /** 流末：返回干净的完整文本 + 尚未发出的尾巴。 */
  final(): { text: string; remainder: string } {
    const text = stripToolCallMarkup(this.buffer, { final: true });
    const remainder = text.startsWith(this.emitted) ? text.slice(this.emitted.length) : "";
    return { text, remainder };
  }

  get raw(): string {
    return this.buffer;
  }
}

export interface AgentDeps {
  /** 解析 model id → 引擎（通常是 EngineRegistry.resolve）。 */
  resolveEngine(model: string): InferenceEngine;
  tools: ToolRegistry;
  approval: ApprovalGate;
  workspaceDir: string;
  /** 可选记忆提供商：生成前 recall 注入、生成后 observe。 */
  memory?: MemoryProvider;
  recallOptions?: { topK?: number; minScore?: number };
  /** 本轮只能调用一次的工具集合（默认含 render_html）。 */
  oneShotTools?: Set<string>;
  /** 请求级附加工具（如按所选知识库集合作用域的 search_knowledge_base）。 */
  extraTools?: Tool[];
}

/**
 * Agent 运行循环：model → tool calls → tool results → model …
 * - 非原生 tool-call 引擎：尾缓冲剥离 markup 流式输出，流末解析 tool calls。
 * - canonicalToolCallKey 去重打断重复调用；max-iterations 兜底。
 * - tool 错误一律作为 tool 消息喂回模型自纠，绝不抛出。
 */
/** 本轮只能调用一次的工具（二次调用作为 noop 提示）。 */
const ONE_SHOT_TOOLS = new Set(["render_html"]);
/** 累计多少次重复/无效调用后，强制无工具的最终回答轮（参考 Unsloth duplicate_noop_limit）。 */
const DUPLICATE_NOOP_LIMIT = 2;

export async function* runAgent(input: AgentRunInput, deps: AgentDeps): AsyncIterable<AgentEvent> {
  const messages: ChatMessage[] = [...input.history];
  const maxIter = input.maxIterations ?? 25;
  const oneShot = deps.oneShotTools ?? ONE_SHOT_TOOLS;
  const seen = new Set<string>();
  const completedOneShot = new Set<string>();
  const approvedTools = new Set<string>();
  const usedTools = new Set<string>();
  let noopCount = 0;
  let forceFinal = false;
  let nudgedFinal = false;
  const signal = input.signal ?? new AbortController().signal;
  const ctx: ToolExecContext = {
    sessionId: input.threadId,
    workspaceDir: deps.workspaceDir,
    signal,
    approval: deps.approval,
  };

  let lastAssistant: ChatMessage = { role: "assistant", content: "" };

  // 生成前：语义/词法召回相关记忆，注入为系统上下文（带 topK/minScore 防稀释）。
  if (deps.memory) {
    const lastUser = [...input.history].reverse().find((m) => m.role === "user");
    const query = lastUser ? messageText(lastUser.content) : "";
    if (query) {
      try {
        const hits = await deps.memory.recall({
          query,
          sessionId: input.threadId,
          ...(deps.recallOptions?.topK != null ? { topK: deps.recallOptions.topK } : {}),
          ...(deps.recallOptions?.minScore != null ? { minScore: deps.recallOptions.minScore } : {}),
        });
        if (hits.length > 0) {
          yield { type: "memory-recall", count: hits.length };
          const ctx = `相关记忆（供参考）：\n${hits.map((h) => `- ${h.text}`).join("\n")}`;
          messages.unshift({ role: "system", content: ctx });
        }
      } catch {
        /* 召回失败不阻断 */
      }
    }
  }

  for (let iter = 0; iter < maxIter; iter++) {
    const engine = deps.resolveEngine(input.model);
    // 强制收尾轮：不再提供工具，并注入一次性提示，让模型基于已有结果直接作答。
    if (forceFinal && !nudgedFinal) {
      messages.push({
        role: "user",
        content: "请基于已获得的工具结果直接给出最终回答，不要再调用任何工具。",
      });
      nudgedFinal = true;
    }
    const allTools = forceFinal ? [] : [...(await deps.tools.list(ctx)), ...(deps.extraTools ?? [])];
    const exclude = new Set(input.excludeTools ?? []);
    const toolList = exclude.size ? allTools.filter((t) => !exclude.has(t.definition.name)) : allTools;
    const toolMap = new Map(toolList.map((t) => [t.definition.name, t]));
    const toolDefs = toolList.map((t) => t.definition);

    const stripper = new TailStripper();
    let nativeToolCalls: ToolCall[] | undefined;

    const stream = engine.chatStream({
      model: input.model,
      messages,
      ...(toolDefs.length ? { tools: toolDefs, toolChoice: "auto" as const } : {}),
      ...(input.sampling ?? {}),
      signal,
    });
    for await (const ev of stream) {
      if (ev.type === "text-delta") {
        const out = stripper.push(ev.text);
        if (out) yield { type: "text", text: out };
      } else if (ev.type === "reasoning-delta") {
        yield { type: "reasoning", text: ev.text };
      } else if (ev.type === "usage") {
        yield { type: "usage", usage: ev.usage };
      } else if (ev.type === "done") {
        nativeToolCalls = ev.message.toolCalls;
      } else if (ev.type === "error") {
        yield { type: "error", message: ev.message };
        return;
      }
    }

    const { text: finalText, remainder } = stripper.final();
    if (remainder) yield { type: "text", text: remainder };

    const toolCalls: ToolCall[] = forceFinal
      ? []
      : nativeToolCalls && nativeToolCalls.length > 0
        ? nativeToolCalls
        : parseToolCallsFromText(stripper.raw);

    const assistant: ChatMessage = {
      role: "assistant",
      content: finalText,
      ...(toolCalls.length ? { toolCalls } : {}),
    };
    messages.push(assistant);
    lastAssistant = assistant;

    if (toolCalls.length === 0) {
      yield { type: "final", message: assistant };
      // 生成后：抽取/摘要写入记忆（失败不影响）。
      if (deps.memory) {
        await deps.memory.observe({ messages, sessionId: input.threadId }).catch(() => {});
      }
      return;
    }

    const noop = (tcId: string, content: string): void => {
      messages.push({ role: "tool", toolCallId: tcId, content });
      noopCount++;
      if (noopCount >= DUPLICATE_NOOP_LIMIT) forceFinal = true;
    };

    for (const tc of toolCalls) {
      // one-shot 工具二次调用 → noop 提示，不再执行。
      if (oneShot.has(tc.name) && completedOneShot.has(tc.name)) {
        noop(tc.id, `(${tc.name} 本轮只能调用一次，已执行过；请基于其结果继续或直接给出最终回答)`);
        continue;
      }

      const key = canonicalToolCallKey(tc.name, tc.arguments);
      if (seen.has(key)) {
        noop(tc.id, "(重复调用相同参数，已跳过；请勿重复调用，用已有结果继续或给出最终回答)");
        continue;
      }
      seen.add(key);

      const tool = toolMap.get(tc.name);
      if (!tool) {
        noop(tc.id, `错误：未知工具 ${tc.name}（请只调用可用工具列表中的工具）`);
        continue;
      }

      let args: unknown;
      try {
        args = JSON.parse(tc.arguments || "{}");
      } catch {
        noop(tc.id, "错误：参数 JSON 解析失败（请输出合法 JSON 参数）");
        continue;
      }

      const isFirstUse = !usedTools.has(tc.name) && !approvedTools.has(tc.name);
      if (needsApproval(tool.requiresApproval, args, isFirstUse)) {
        const verdict = await ctx.approval.request({ toolName: tc.name, args });
        if (verdict === "deny") {
          noop(tc.id, "(用户拒绝执行该工具；请换一种方式或直接给出最终回答)");
          continue;
        }
        if (verdict === "approve-always") approvedTools.add(tc.name);
      }
      usedTools.add(tc.name);

      yield { type: "tool-start", call: tc };
      let result: ToolResult;
      try {
        result = await tool.execute(args, ctx);
      } catch (e) {
        result = { content: `执行错误: ${e instanceof Error ? e.message : String(e)}`, isError: true };
      }
      yield { type: "tool-end", call: tc, result };
      messages.push({ role: "tool", toolCallId: tc.id, content: result.content });
      if (oneShot.has(tc.name) && !result.isError) completedOneShot.add(tc.name);
    }
  }

  // 迭代用尽：强制收尾。
  yield { type: "final", message: lastAssistant };
}
