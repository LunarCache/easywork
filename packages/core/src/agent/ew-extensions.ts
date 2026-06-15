// R3 — EasyWork 专有能力以 pi 扩展/customTool 形式接入托管的 AgentSession：
//  - 记忆：pi `context` 钩子注入召回 + `agent_end` 钩子被动抽取（保留 LocalMemoryProvider）。
//  - 知识库 / session 检索 / MCP：桥成 pi customTools。
import path from "node:path";
import fs from "node:fs";
import { Type } from "typebox";
import type {
  ExtensionAPI,
  ExtensionFactory,
  ToolDefinition as PiToolDefinition,
  AgentToolResult,
  ContextEvent,
  AgentEndEvent,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import type {
  Tool,
  ToolExecContext,
  ApprovalGate,
  ApprovalMode,
  SamplingParams,
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
      if (res.isError) throw new Error(contentText(res.content) || "tool_error");
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
  builtins?: Tool[];
}): Promise<PiToolDefinition[]> {
  const base = { sessionId: opts.sessionId, cwd: opts.cwd };
  const tools: Tool[] = [];
  if (opts.builtins) tools.push(...opts.builtins);
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
  /** 召回缓存挂在 run 运行时上，由宿主每轮重置（避免同 query 跨轮复用陈旧召回）。 */
  runtime: RunRuntime;
}): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.on("context", async (event: ContextEvent) => {
      const query = lastUserText(event.messages);
      if (!query) return;
      const rt = opts.runtime;
      // 工具循环里同一 query 复用本轮召回，避免反复 embedding；run() 开始已清空。
      if (!rt.recall || rt.recall.key !== query) {
        const items = await opts.memory.recall({ query, topK: 6, minScore: 0.3 }).catch(() => [] as MemoryItem[]);
        rt.recall = { key: query, block: items.length ? formatRecall(items) : "" };
      }
      if (!rt.recall.block) return;
      const injected = { role: "user" as const, content: rt.recall.block, timestamp: Date.now() };
      return { messages: [injected, ...event.messages] };
    });
    pi.on("agent_end", (event: AgentEndEvent) => {
      const messages = event.messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role, content: contentText(m.content as string | ContentPart[]) }))
        .filter((m) => !m.content.startsWith(RECALL_MARKER));
      // 后台抽取事实：不 await——否则 pi 会等它跑完才让 run 收尾，SSE 迟迟不关、
      // UI 光标在输出结束后仍持续闪烁。抽取是 best-effort，放到后台跑。
      void opts.memory
        .observe({ messages, sessionId: opts.threadId, model: opts.modelId })
        .catch(() => {});
    });
  };
}

/** 每轮运行的权限/记忆上下文（run() 前由宿主写入/重置；扩展闭包读取）。 */
export interface RunRuntime {
  mode: ApprovalMode;
  approval?: ApprovalGate;
  /** approve-always 记忆：本会话内该工具后续放行。 */
  alwaysApproved: Set<string>;
  /** 本轮召回缓存（run() 开始时重置，避免同一 query 跨轮复用陈旧召回）。 */
  recall?: { key: string; block: string };
  /** 本轮采样参数（run() 前写入；streamFn 包装读取，注入 provider 请求）。 */
  sampling?: SamplingParams;
}

const READ_TOOLS = new Set(["read", "ls", "grep", "find"]);
const WRITE_TOOLS = new Set(["edit", "write"]);

type ToolClass = "read" | "write" | "bash" | "mcp" | "safe";

function classify(name: string): ToolClass {
  if (READ_TOOLS.has(name)) return "read";
  if (WRITE_TOOLS.has(name)) return "write";
  if (name === "bash") return "bash";
  if (name.startsWith("mcp__")) return "mcp";
  return "safe";
}

/**
 * 工作区审批档位 → 决策（对齐 legacy workspace-approval）：
 * | mode         | read | write(edit/write) | bash | mcp__ |
 * | read-only    | 放行 | 阻止              | 阻止 | 阻止  |
 * | approve-each | 放行 | 审批              | 审批 | 审批  |
 * | auto-edits   | 放行 | 放行              | 审批 | 审批  |
 * | full-auto    | 放行 | 放行              | 放行 | 放行  |
 * 读类工具与 EasyWork 安全 customTools（记忆/检索/KB）一律放行。
 */
export function decideTool(name: string, mode: ApprovalMode): "allow" | "block" | "approve" {
  const cls = classify(name);
  if (cls === "read" || cls === "safe") return "allow";
  if (mode === "read-only") return "block";
  if (mode === "full-auto") return "allow";
  if (cls === "write") return mode === "approve-each" ? "approve" : "allow"; // auto-edits 放行写
  return "approve"; // bash / mcp：除 full-auto 外均审批
}

/** 取路径的「真实」绝对路径：对最深的已存在祖先 realpath（解析软链接），再拼回不存在的尾段。 */
function realResolve(abs: string): string {
  const parts: string[] = [];
  let cur = path.resolve(abs);
  for (;;) {
    try {
      const base = fs.realpathSync(cur);
      return parts.length ? path.join(base, ...parts.slice().reverse()) : base;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(abs); // 到根仍不存在 → 退回词法
      parts.push(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * fs 工具的路径参数是否逃出工作区（pi 自带工具不做路径沙箱，需我们兜住）。
 * 经 realpath 解析软链接后再比对，防止「工作区内软链接指向外部」绕过。
 * 返回越界的路径字符串，未越界返回 null。bash 是任意 shell，不在此静态检查（由审批把守）。
 */
export function escapesCwd(toolName: string, input: unknown, cwd: string): string | null {
  if (classify(toolName) === "bash") return null;
  const obj = (input ?? {}) as Record<string, unknown>;
  const root = realResolve(path.resolve(cwd));
  for (const key of ["path", "file_path", "dir", "directory", "old_path", "new_path"]) {
    const v = obj[key];
    if (typeof v !== "string" || !v) continue;
    const real = realResolve(path.resolve(path.resolve(cwd), v));
    if (real !== root && !real.startsWith(root + path.sep)) return v;
  }
  return null;
}

/** 权限扩展工厂：pi `tool_call` 钩子按 RunRuntime 决策放行/阻止/审批（经 EasyWork ApprovalGate）。 */
export function permissionExtensionFactory(runtime: RunRuntime, cwd: string): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.on("tool_call", async (event: ToolCallEvent): Promise<ToolCallEventResult> => {
      // 硬边界：fs 工具的路径不得逃出工作区（所有档位均拒，pi 不自带沙箱）。
      const esc = escapesCwd(event.toolName, event.input, cwd);
      if (esc) return { block: true, reason: `路径越界被拒（限定在工作区内）：${esc}` };
      const d = decideTool(event.toolName, runtime.mode);
      if (d === "allow") return {};
      if (d === "block") return { block: true, reason: `当前「${runtime.mode}」模式禁止 ${event.toolName}` };
      if (runtime.alwaysApproved.has(event.toolName)) return {};
      if (!runtime.approval) return {}; // 无审批门（无 UI 连接）→ 放行，避免无人应答而卡死
      const verdict = await runtime.approval.request({ toolName: event.toolName, args: event.input });
      if (verdict === "deny") return { block: true, reason: "用户拒绝了该操作" };
      if (verdict === "approve-always") runtime.alwaysApproved.add(event.toolName);
      return {};
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
