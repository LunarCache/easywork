// 把 EasyWork 的 Tool（zod 定义）适配为 pi 的 AgentTool（typebox schema），供 pi agentLoop 调度。
// - 参数 schema：用 Type.Unsafe 直接包我们 defineTool 产出的 JSON Schema（模型看到正确 schema；
//   我们 tool.execute 内部仍会用 zod 二次校验）。
// - 执行：调用我们的 tool.execute(args, ctx)；ToolResult.content→pi content、display→details、
//   isError→抛错（pi 约定：失败抛错，由 loop 转成 error tool result 喂回模型自纠）。
// - 流式：我们的 ctx.emit("tool-progress") 桥接到 pi 的 onUpdate（→ tool_execution_update 事件）。
import { Type } from "typebox";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ContentPart, Tool, ToolExecContext, ToolResult } from "@ew/shared";

/** baseCtx：每次工具执行的固定上下文部分（signal/callId/emit 由 pi 每次调用补齐）。 */
export type BaseToolCtx = Omit<ToolExecContext, "signal" | "callId" | "emit">;

const NEVER = new AbortController().signal;

function textOf(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("");
}

/** 我们的 ToolResult.content → pi 的 (Text|Image)[]（仅 text/image，丢弃 audio/file/url 图）。 */
export function toPiContent(content: string | ContentPart[]): (TextContent | ImageContent)[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  const out: (TextContent | ImageContent)[] = [];
  for (const p of content) {
    if (p.type === "text") out.push({ type: "text", text: p.text });
    else if (p.type === "image" && typeof p.data === "string")
      out.push({ type: "image", data: p.data, mimeType: p.mimeType });
  }
  return out.length ? out : [{ type: "text", text: "" }];
}

/**
 * 适配单个工具。opts.executionMode：写类工具传 "sequential" 避免并发写竞态；读类默认并行。
 */
export function toPiTool(
  tool: Tool,
  baseCtx: BaseToolCtx,
  opts?: { executionMode?: "sequential" | "parallel" },
): AgentTool {
  const def = tool.definition;
  return {
    name: def.name,
    label: def.name,
    description: def.description,
    // 直接包 JSON Schema：pi 把它发给模型，并用它做参数校验。
    parameters: Type.Unsafe(def.parameters as Record<string, unknown>),
    ...(opts?.executionMode ? { executionMode: opts.executionMode } : {}),
    async execute(
      toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback,
    ): Promise<AgentToolResult<unknown>> {
      const ctx: ToolExecContext = {
        ...baseCtx,
        signal: signal ?? NEVER,
        callId: toolCallId,
        emit: (ev) => {
          // 仅桥接流式进度（run_command stdout/stderr）→ pi onUpdate。
          if (ev.type === "tool-progress") {
            onUpdate?.({
              content: [{ type: "text", text: String(ev.chunk ?? "") }],
              details: { kind: "tool-progress", stream: ev.stream, callId: ev.callId },
            });
          }
        },
      };
      const res: ToolResult = await tool.execute(params, ctx);
      if (res.isError) throw new Error(textOf(res.content) || `${def.name} 执行失败`);
      return { content: toPiContent(res.content), details: res.display ?? null };
    },
  };
}
