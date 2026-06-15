// 聊天 / 工作区共享的 agent 流式逻辑：数据模型 + 纯函数 + 事件归约器。
import type { AgentEvent } from "@ew/shared";

export interface UiTool {
  id: string;
  name: string;
  args: string;
  result?: string;
  /** run_command 流式累积的 stdout/stderr（tool-progress）。 */
  output?: string;
  status: "running" | "done" | "error";
  sources?: { title: string; url: string }[];
  html?: string;
  htmlTitle?: string;
  citations?: { id: number; source: string; score?: number }[];
  /** 工作区 fs_write/fs_edit 的 diff 载荷。 */
  diff?: { path: string; before: string | null; after: string; unified: string | null };
}
export interface PendingApproval {
  id: string;
  toolName: string;
  args: unknown;
}
export interface UiImage {
  mimeType: string;
  data: string; // base64（无 data: 前缀）
}
/** 助手回复的有序时间线块：思考 → 工具 → 思考 → … → 文本（保留真实先后顺序）。 */
export type UiBlock =
  | { kind: "reasoning"; text: string; start: number; end?: number }
  | { kind: "tool"; tool: UiTool }
  | { kind: "text"; text: string };

export interface UiMsg {
  role: "user" | "assistant";
  raw: string;
  reasoning: string;
  tools: UiTool[];
  /** 有序时间线（渲染源）：思考/工具/文本按发生顺序排列。 */
  blocks?: UiBlock[];
  images?: UiImage[];
  start?: number;
  thinkEnd?: number;
}

export function splitThink(raw: string): { reasoning: string; answer: string } {
  let reasoning = "";
  let answer = "";
  let cursor = 0;
  while (cursor < raw.length) {
    const open = raw.indexOf("<think>", cursor);
    if (open === -1) {
      answer += raw.slice(cursor);
      break;
    }
    answer += raw.slice(cursor, open);
    const start = open + 7;
    const close = raw.indexOf("</think>", start);
    if (close === -1) {
      reasoning += raw.slice(start);
      break;
    }
    reasoning += raw.slice(start, close);
    cursor = close + 8;
  }
  return { reasoning: reasoning.trim(), answer: answer.trim() };
}

export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .filter((p) => (p as { type?: string }).type === "text")
      .map((p) => (p as { text?: string }).text ?? "")
      .join("");
  return "";
}

export function modelLabel(m: string): string {
  if (m.includes("/") || m.includes("\\")) return (m.split(/[/\\]/).pop() ?? m).replace(/\.gguf$/i, "");
  return m;
}

/** 从工具结果的 display 载荷解析出 UI 富渲染补丁（来源/引用/HTML 工件/diff）。流式与历史回放共用。 */
export function toolDisplayPatch(display: unknown): Partial<UiTool> {
  const patch: Partial<UiTool> = {};
  if (Array.isArray(display)) {
    patch.sources = (display as { title?: string; url?: string }[])
      .filter((s) => s?.url)
      .map((s) => ({ title: s.title ?? "", url: s.url! }));
  } else if (display && typeof display === "object") {
    const d = display as {
      kind?: string;
      html?: string;
      title?: string;
      sources?: unknown;
      path?: string;
      before?: string | null;
      after?: string;
      unified?: string | null;
    };
    if (d.kind === "html" && typeof d.html === "string") {
      patch.html = d.html;
      if (d.title) patch.htmlTitle = d.title;
    } else if (d.kind === "citations" && Array.isArray(d.sources)) {
      patch.citations = d.sources as { id: number; source: string; score?: number }[];
    } else if (d.kind === "diff" && typeof d.after === "string" && typeof d.path === "string") {
      patch.diff = { path: d.path, before: d.before ?? null, after: d.after, unified: d.unified ?? null };
    }
  }
  return patch;
}

interface StoredPart {
  type: string;
  text?: string;
  mimeType?: string;
  data?: string;
}
export interface StoredMsg {
  role: string;
  parts: StoredPart[];
  toolCalls?: { id: string; name: string; arguments: string }[];
  toolResults?: { content: unknown; isError?: boolean; display?: unknown }[];
}

function imagesOf(parts: StoredPart[]): UiImage[] {
  return parts
    .filter((p) => p.type === "image" && p.data)
    .map((p) => ({ mimeType: p.mimeType ?? "image/png", data: p.data! }));
}

/**
 * 把存档的扁平消息列表（user / assistant[含 toolCalls] / tool[含 toolResults]）
 * 折叠回 UiMsg[]：每个用户消息后的 assistant+tool 序列合并为一条 assistant 气泡（含工具卡）。
 */
export function storedToUiMsgs(list: StoredMsg[]): UiMsg[] {
  const out: UiMsg[] = [];
  let bubble: UiMsg | null = null;
  let pending = 0;
  const flush = () => {
    if (bubble) out.push(bubble);
    bubble = null;
    pending = 0;
  };
  for (const m of list) {
    const text = messageText(m.parts);
    if (m.role === "user") {
      flush();
      const imgs = imagesOf(m.parts);
      out.push({ role: "user", raw: text, reasoning: "", tools: [], ...(imgs.length ? { images: imgs } : {}) });
      continue;
    }
    if (m.role === "assistant") {
      if (!bubble) bubble = { role: "assistant", raw: "", reasoning: "", tools: [], blocks: [] };
      if (text) {
        bubble.raw = bubble.raw ? `${bubble.raw}\n${text}` : text;
        bubble.blocks!.push({ kind: "text", text });
      }
      for (const c of m.toolCalls ?? []) {
        const t: UiTool = { id: c.id, name: c.name, args: c.arguments, status: "done" };
        bubble.tools.push(t);
        bubble.blocks!.push({ kind: "tool", tool: t }); // 同一引用，下面打补丁即更新时间线
      }
      continue;
    }
    if (m.role === "tool" && bubble) {
      const r = m.toolResults?.[0];
      while (pending < bubble.tools.length && bubble.tools[pending]!.result != null) pending++;
      if (pending < bubble.tools.length) {
        const t = bubble.tools[pending]!;
        t.result = text || (typeof r?.content === "string" ? r.content : "");
        t.status = r?.isError ? "error" : "done";
        Object.assign(t, toolDisplayPatch(r?.display));
        pending++;
      }
    }
  }
  flush();
  return out;
}

/**
 * 把一个 agent 流事件归约进当前（最后一条 assistant）消息。
 * 仅处理消息级事件：text / reasoning / tool-start / tool-end / tool-progress。
 * usage / approval-request / final / error 由调用方在 loop 层处理。
 */
/** 收尾仍打开的思考块（设 end），便于显示"思考了 N 秒"。返回新数组。 */
function closeReasoning(blocks: UiBlock[], now: number): UiBlock[] {
  const last = blocks[blocks.length - 1];
  if (last && last.kind === "reasoning" && last.end == null) {
    return [...blocks.slice(0, -1), { ...last, end: now }];
  }
  return blocks;
}

/** 在时间线上更新某工具块（按 id）。 */
function patchToolBlock(blocks: UiBlock[], id: string, patch: Partial<UiTool>): UiBlock[] {
  return blocks.map((b) => (b.kind === "tool" && b.tool.id === id ? { kind: "tool", tool: { ...b.tool, ...patch } } : b));
}

export function applyAgentEvent(m: UiMsg, ev: AgentEvent): UiMsg {
  const blocks = m.blocks ?? [];
  switch (ev.type) {
    case "text": {
      const now = Date.now();
      const raw = m.raw + ev.text;
      const start = m.start ?? now;
      const ended = raw.includes("</think>") || (!!m.reasoning && splitThink(raw).answer.length > 0);
      const thinkEnd = m.thinkEnd ?? (ended ? now : undefined);
      // 时间线：合并进末尾文本块，否则（思考/工具之后）新开文本块。
      const nb = closeReasoning(blocks, now);
      const last = nb[nb.length - 1];
      const blocks2: UiBlock[] =
        last && last.kind === "text"
          ? [...nb.slice(0, -1), { kind: "text", text: last.text + ev.text }]
          : [...nb, { kind: "text", text: ev.text }];
      return { ...m, raw, start, blocks: blocks2, ...(thinkEnd ? { thinkEnd } : {}) };
    }
    case "reasoning": {
      const now = Date.now();
      const last = blocks[blocks.length - 1];
      const blocks2: UiBlock[] =
        last && last.kind === "reasoning"
          ? [...blocks.slice(0, -1), { ...last, text: last.text + ev.text }]
          : [...blocks, { kind: "reasoning", text: ev.text, start: now }];
      return { ...m, reasoning: m.reasoning + ev.text, start: m.start ?? now, blocks: blocks2 };
    }
    case "tool-start": {
      const tool: UiTool = { id: ev.call.id, name: ev.call.name, args: ev.call.arguments, status: "running" };
      const nb = closeReasoning(blocks, Date.now());
      return { ...m, tools: [...m.tools, tool], blocks: [...nb, { kind: "tool", tool }] };
    }
    case "tool-progress":
      return {
        ...m,
        tools: m.tools.map((t) => (t.id === ev.callId ? { ...t, output: (t.output ?? "") + ev.chunk } : t)),
        blocks: blocks.map((b) =>
          b.kind === "tool" && b.tool.id === ev.callId
            ? { kind: "tool", tool: { ...b.tool, output: (b.tool.output ?? "") + ev.chunk } }
            : b,
        ),
      };
    case "tool-end": {
      const patch: Partial<UiTool> = {
        result: String(ev.result.content),
        status: ev.result.isError ? "error" : "done",
        ...toolDisplayPatch((ev.result as { display?: unknown }).display),
      };
      return {
        ...m,
        tools: m.tools.map((t) => (t.id === ev.call.id ? { ...t, ...patch } : t)),
        blocks: patchToolBlock(blocks, ev.call.id, patch),
      };
    }
    default:
      return m;
  }
}
