// R3 — EasyWork 专有能力以 pi 扩展/customTool 形式接入托管的 AgentSession：
//  - 记忆：pi `context` 钩子注入召回 + `agent_end` 钩子被动抽取（保留 LocalMemoryProvider）。
//  - 知识库 / session 检索 / MCP：桥成 pi customTools。
import { Type } from "typebox";
import type {
  ExtensionAPI,
  ExtensionFactory,
  ToolDefinition as PiToolDefinition,
  AgentToolResult,
  ContextEvent,
  AgentEndEvent,
} from "@earendil-works/pi-coding-agent";
import type {
  Tool,
  ToolExecContext,
  ApprovalGate,
  MemoryProvider,
  MemoryItem,
  ContentPart,
  ConversationRepo,
} from "@ew/shared";
import type { KnowledgeBaseStore } from "../rag/store.js";
import type { McpClientManager } from "@ew/mcp";
import { makeMemoryTool } from "../memory/memory-tool.js";
import { makeSessionSearchTool } from "../memory/session-search-tool.js";
import { makeSearchKnowledgeBaseTool } from "../rag/tool.js";

/** 注入记忆块的前缀标记（用于在 context 钩子里识别并跳过本扩展自己注入的消息）。 */
const RECALL_MARKER = "【相关记忆】";

/** 桥接工具默认自动批准：MCP/KB/记忆无需 EW 审批；pi 自带工具的审批由 pi 自身负责。 */
const autoApprove: ApprovalGate = { request: async () => "approve" };

/** 我们的 `Tool` → pi customTool（ToolDefinition）。既有 JSON Schema 用 `Type.Unsafe` 包裹。 */
export function toPiTool(tool: Tool, base: { sessionId: string; cwd: string }): PiToolDefinition {
  return {
    name: tool.definition.name,
    label: tool.definition.name,
    description: tool.definition.description,
    parameters: Type.Unsafe(tool.definition.parameters),
    async execute(_toolCallId, params, signal): Promise<AgentToolResult<unknown>> {
      const ctx: ToolExecContext = {
        sessionId: base.sessionId,
        workspaceDir: base.cwd,
        signal: signal ?? new AbortController().signal,
        approval: autoApprove,
      };
      const res = await tool.execute(params, ctx);
      // pi 以「抛出」表达工具错误（loop 捕获 → 作为 isError 的 tool result 喂回模型自纠）。
      if (res.isError) throw new Error(contentText(res.content));
      return { content: toPiContent(res.content), details: res.display ?? null };
    },
  };
}

/** 组装 EasyWork 专有 customTools（记忆管理 / session 检索 / 知识库 / MCP）。 */
export async function buildEwCustomTools(opts: {
  sessionId: string;
  cwd: string;
  memory?: MemoryProvider;
  repo?: ConversationRepo;
  kb?: KnowledgeBaseStore;
  mcp?: McpClientManager;
}): Promise<PiToolDefinition[]> {
  const base = { sessionId: opts.sessionId, cwd: opts.cwd };
  const tools: Tool[] = [];
  if (opts.memory) tools.push(makeMemoryTool(opts.memory));
  if (opts.repo) tools.push(makeSessionSearchTool(opts.repo));
  if (opts.kb) tools.push(makeSearchKnowledgeBaseTool(opts.kb));
  if (opts.mcp) {
    try {
      const dummy: ToolExecContext = {
        sessionId: opts.sessionId,
        workspaceDir: opts.cwd,
        signal: new AbortController().signal,
        approval: autoApprove,
      };
      tools.push(...(await opts.mcp.toolProvider().tools(dummy)));
    } catch {
      /* MCP 列举失败不阻塞会话创建 */
    }
  }
  return tools.map((t) => toPiTool(t, base));
}

/** 记忆扩展工厂：context 注入召回（每轮请求前）+ agent_end 被动事实抽取。 */
export function memoryExtensionFactory(opts: {
  threadId: string;
  modelId: string;
  memory: MemoryProvider;
}): ExtensionFactory {
  // 同一轮运行内 query 不变 → 缓存召回结果，避免工具循环里反复 embedding。
  let cache: { key: string; block: string } | null = null;
  return (pi: ExtensionAPI) => {
    pi.on("context", async (event: ContextEvent) => {
      const query = lastUserText(event.messages);
      if (!query) return;
      if (!cache || cache.key !== query) {
        const items = await opts.memory.recall({ query, topK: 6, minScore: 0.3 }).catch(() => [] as MemoryItem[]);
        cache = { key: query, block: items.length ? formatRecall(items) : "" };
      }
      if (!cache.block) return;
      const injected = { role: "user" as const, content: cache.block, timestamp: Date.now() };
      return { messages: [injected, ...event.messages] };
    });
    pi.on("agent_end", async (event: AgentEndEvent) => {
      const messages = event.messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role, content: contentText(m.content as string | ContentPart[]) }))
        .filter((m) => !m.content.startsWith(RECALL_MARKER));
      await opts.memory
        .observe({ messages, sessionId: opts.threadId, model: opts.modelId })
        .catch(() => {});
    });
  };
}

/** 召回项渲染成注入块（带标记，便于识别/跳过）。 */
function formatRecall(items: MemoryItem[]): string {
  const lines = items.map((it) => `- [${it.layer}] ${it.text}`);
  return `${RECALL_MARKER}（供参考，未必相关）：\n${lines.join("\n")}`;
}

/** 取最后一条「非注入」的用户消息文本。 */
function lastUserText(messages: ContextEvent["messages"]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    const t = contentText(m.content as string | ContentPart[]);
    if (t.startsWith(RECALL_MARKER)) continue;
    if (t.trim()) return t;
  }
  return "";
}

/** pi/EW 内容（string | parts）→ 纯文本。 */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p): p is { type: "text"; text: string } => !!p && (p as { type?: string }).type === "text")
      .map((p) => p.text)
      .join("");
  }
  return "";
}

/** 我们的 ToolResult.content（string | ContentPart[]）→ pi content 数组。 */
function toPiContent(content: string | ContentPart[]): AgentToolResult<unknown>["content"] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  const out: AgentToolResult<unknown>["content"] = [];
  for (const p of content) {
    if (p.type === "text") out.push({ type: "text", text: p.text });
    else if (p.type === "image" && typeof p.data === "string") out.push({ type: "image", data: p.data, mimeType: p.mimeType });
  }
  if (out.length === 0) out.push({ type: "text", text: "" });
  return out;
}
