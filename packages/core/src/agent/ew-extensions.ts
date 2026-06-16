// R3 — EasyWork 专有能力以 pi 扩展/customTool 形式接入托管的 AgentSession：
//  - 记忆：渐进式披露（`before_agent_start` 注入「记忆清单」到系统提示词 + recall_memory 工具按需取全文）
//          + 批量被动抽取（空闲去抖 / 压缩 / 关闭时，非每轮）。作用域化（global 对话池 + 每工作区独立池）。
//  - 知识库 / session 检索 / MCP：桥成 pi customTools。
import path from "node:path";
import fs from "node:fs";
import { Type } from "typebox";
import type {
  ExtensionAPI,
  ExtensionFactory,
  ToolDefinition as PiToolDefinition,
  AgentToolResult,
  AgentEndEvent,
  BeforeAgentStartEvent,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import {
  GLOBAL_SCOPE,
  isWorkspaceScope,
  visibleScopes,
  type Tool,
  type ToolExecContext,
  type ApprovalGate,
  type ApprovalMode,
  type SamplingParams,
  type MemoryProvider,
  type MemoryLayer,
  type ScopeView,
  type ContentPart,
  type ConversationRepo,
} from "@ew/shared";
import type { KnowledgeBaseStore } from "../rag/store.js";
import type { McpClientManager } from "@ew/mcp";
import { makeMemoryTool } from "../memory/memory-tool.js";
import { makeRecallMemoryTool } from "../memory/recall-memory-tool.js";
import { makeSessionSearchTool } from "../memory/session-search-tool.js";
import { makeSearchKnowledgeBaseTool } from "../rag/tool.js";

/** 被动抽取的空闲去抖时长：一轮结束后停顿这么久没有新输入，才批量抽取一次。 */
const EXTRACT_IDLE_MS = 90_000;
/** 累积到这么多条「未抽取」的新消息就立即批量抽一次（防止长突发里缓冲无限增长/早期轮次漏抽）。 */
const EXTRACT_MAX_TURNS = 24;

/** (scope,layer) → 清单里的人类标签。prefixGlobal=true 时给全局层标「全局·」（用于工作区会话里区分共享身份）。 */
function manifestLabel(scope: string, layer: MemoryLayer, prefixGlobal: boolean): string {
  const GLOBAL: Record<string, string> = {
    "user-profile": "用户画像",
    "agent-memory": "长期记忆",
    skills: "技能/流程",
  };
  const WS: Record<string, string> = {
    conventions: "本工程·约定/约束",
    decisions: "本工程·变动/决策",
    pitfalls: "本工程·坑/教训",
  };
  if (isWorkspaceScope(scope)) return WS[layer] ?? layer;
  const label = GLOBAL[layer] ?? layer;
  return prefixGlobal ? `全局·${label}` : label;
}

function oneLine(text: string, max = 80): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * 构造「记忆清单」（渐进式披露的常驻索引，借鉴 Skill 的描述常驻）：按可见作用域+层列出每条要点
 * （仅标题/截断），不灌全文；让模型知道有哪些记忆存在，细节经 recall_memory 工具按需取。空则 ""。
 */
export async function buildMemoryManifest(memory: MemoryProvider, views: ScopeView[]): Promise<string> {
  // 工作区会话同时含 ws 与 global 两个视图 → 给全局层加「全局·」前缀以区分共享身份。
  const prefixGlobal = views.some((v) => isWorkspaceScope(v.scope));
  const sections: string[] = [];
  for (const v of views) {
    for (const layer of v.layers) {
      const items = await memory.list({ scope: v.scope, layer });
      if (items.length === 0) continue;
      const lines = items.map((it) => `- ${oneLine(it.text)}`);
      sections.push(`### ${manifestLabel(v.scope, layer, prefixGlobal)}\n${lines.join("\n")}`);
    }
  }
  if (sections.length === 0) return "";
  return (
    `# 你的长期记忆（清单）\n` +
    `下面只列要点；需要某条完整内容、或想按主题检索记忆时，调用 recall_memory 工具。` +
    `要新增/修改记忆用 manage_memory 工具。\n\n${sections.join("\n\n")}`
  );
}

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

/** 组装 EasyWork 专有 customTools（记忆管理/检索 · session 检索 · 知识库 · MCP）。 */
export async function buildEwCustomTools(opts: {
  sessionId: string;
  cwd: string;
  /** 记忆作用域（global / ws:<id>）；决定 manage_memory/recall_memory 读写哪个池。 */
  memoryScope?: string;
  memory?: MemoryProvider;
  repo?: ConversationRepo;
  kb?: KnowledgeBaseStore;
  mcp?: McpClientManager;
  builtins?: Tool[];
}): Promise<PiToolDefinition[]> {
  const base = { sessionId: opts.sessionId, cwd: opts.cwd };
  const scope = opts.memoryScope ?? GLOBAL_SCOPE;
  const tools: Tool[] = [];
  if (opts.builtins) tools.push(...opts.builtins);
  if (opts.memory) {
    tools.push(makeMemoryTool(opts.memory, scope));
    tools.push(makeRecallMemoryTool(opts.memory, scope));
  }
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

/**
 * 记忆扩展工厂（渐进式披露 + 批量抽取）：
 * - `before_agent_start`：把「记忆清单」注入系统提示词（常驻、只列要点，全文经 recall_memory 取）。
 * - 抽取：不再每轮。一轮结束挂去抖定时器（~90s）；停顿/上下文压缩/会话关闭时批量抽一次本作用域记忆。
 * 作用域：global（对话池）或 ws:<id>（工作区私有池）；工作区清单额外含全局 user-profile（只读）。
 */
export function memoryExtensionFactory(opts: {
  threadId: string;
  modelId: string;
  scope: string;
  memory: MemoryProvider;
  runtime: RunRuntime;
}): ExtensionFactory {
  const views = visibleScopes(opts.scope);
  // 增量缓冲：累积「自上次抽取以来的新轮次」（不是每次截整段对话的尾部 → 长突发也不漏早期轮次）。
  let buffer: { role: string; content: string }[] = [];
  let seenLen = 0; // 已纳入缓冲的「过滤后对话」长度（survives compaction：列表变短即重新基线）
  let timer: ReturnType<typeof setTimeout> | undefined;

  const extractNow = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    // 后台抽取（不 await）：写入本作用域；isDuplicateFact 兜住任何重叠。
    void opts.memory
      .observe({ messages: batch, sessionId: opts.threadId, scope: opts.scope, model: opts.modelId })
      .catch(() => {});
  };

  return (pi: ExtensionAPI) => {
    pi.on("before_agent_start", async (event: BeforeAgentStartEvent) => {
      const manifest = await buildMemoryManifest(opts.memory, views).catch(() => "");
      if (!manifest) return;
      return { systemPrompt: `${event.systemPrompt}\n\n${manifest}` };
    });
    pi.on("agent_end", (event: AgentEndEvent) => {
      // 用户取消的这一轮「不计入上下文」：不纳入抽取（上下文回滚由宿主处理）。
      if (opts.runtime.aborted) return;
      const conv = event.messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role, content: contentText(m.content as string | ContentPart[]) }))
        .filter((m) => m.content.trim().length > 0);
      // 只把「新增轮次」入缓冲；列表变短（压缩发生）→ 重新基线，整段入缓冲（事实去重兜重叠）。
      buffer.push(...(conv.length >= seenLen ? conv.slice(seenLen) : conv));
      seenLen = conv.length;
      if (buffer.length === 0) return;
      // 缓冲到阈值就立即分块抽取（防长突发缓冲膨胀/早期轮次漏抽）；否则空闲去抖。
      if (buffer.length >= EXTRACT_MAX_TURNS) {
        extractNow();
      } else {
        if (timer) clearTimeout(timer);
        timer = setTimeout(extractNow, EXTRACT_IDLE_MS);
        timer.unref?.();
      }
    });
    // 上下文压缩前 / 会话关闭前：把缓冲立即抽取（避免被淘汰或丢尾部）。
    pi.on("session_before_compact", () => extractNow());
    pi.on("session_shutdown", () => extractNow());
  };
}

/** 每轮运行的权限/采样上下文（run() 前由宿主写入/重置；扩展闭包读取）。 */
export interface RunRuntime {
  mode: ApprovalMode;
  approval?: ApprovalGate;
  /** approve-always 记忆：本会话内该工具后续放行。 */
  alwaysApproved: Set<string>;
  /** 本轮采样参数（run() 前写入；streamFn 包装读取，注入 provider 请求）。 */
  sampling?: SamplingParams;
  /** 本轮是否被用户取消（取消则跳过记忆抽取；上下文回滚由宿主处理）。 */
  aborted?: boolean;
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
