import { describe, it, expect } from "vitest";
import type { Tool, ToolExecContext, ToolResult } from "@ew/shared";
import { toPiTool, toPiContent, type BaseToolCtx } from "../src/agent/pi/tool-adapter.js";

const baseCtx: BaseToolCtx = {
  sessionId: "s",
  workspaceDir: "/tmp",
  approval: { request: async () => "approve" },
};

function fakeTool(run: (args: unknown, ctx: ToolExecContext) => Promise<ToolResult> | ToolResult): Tool {
  return {
    definition: { name: "demo", description: "d", parameters: { type: "object", properties: { x: { type: "string" } } } },
    source: "builtin",
    requiresApproval: "never",
    execute: async (args, ctx) => run(args, ctx),
  };
}

describe("toPiTool", () => {
  it("映射定义：name/description/label + Type.Unsafe 包 JSON Schema", () => {
    const pi = toPiTool(fakeTool(() => ({ content: "ok" })), baseCtx);
    expect(pi.name).toBe("demo");
    expect(pi.label).toBe("demo");
    expect(pi.description).toBe("d");
    // parameters 透传我们的 JSON Schema（模型看到正确 schema）
    expect((pi.parameters as { type?: string }).type).toBe("object");
  });

  it("execute：string content → pi text content + display→details，透传 callId", async () => {
    let seenCallId: string | undefined;
    const pi = toPiTool(
      fakeTool((_args, ctx) => {
        seenCallId = ctx.callId;
        return { content: "hello", display: { kind: "x" } };
      }),
      baseCtx,
    );
    const r = await pi.execute("call-1", { x: "1" });
    expect(r.content).toEqual([{ type: "text", text: "hello" }]);
    expect(r.details).toEqual({ kind: "x" });
    expect(seenCallId).toBe("call-1");
  });

  it("isError → 抛错（携带文本，pi 转 error tool result 喂回模型）", async () => {
    const pi = toPiTool(fakeTool(() => ({ content: "文件不存在", isError: true })), baseCtx);
    await expect(pi.execute("c", {})).rejects.toThrow(/文件不存在/);
  });

  it("ctx.emit(tool-progress) 桥接到 pi onUpdate", async () => {
    const updates: unknown[] = [];
    const pi = toPiTool(
      fakeTool((_args, ctx) => {
        ctx.emit?.({ type: "tool-progress", callId: ctx.callId, stream: "stdout", chunk: "line\n" });
        return { content: "done" };
      }),
      baseCtx,
    );
    await pi.execute("c", {}, undefined, (u) => updates.push(u));
    expect(updates).toHaveLength(1);
    expect((updates[0] as { content: { text: string }[] }).content[0].text).toBe("line\n");
    expect((updates[0] as { details: { stream: string } }).details.stream).toBe("stdout");
  });

  it("executionMode 透传", () => {
    const pi = toPiTool(fakeTool(() => ({ content: "" })), baseCtx, { executionMode: "sequential" });
    expect(pi.executionMode).toBe("sequential");
  });

  it("toPiContent：ContentPart[] 仅保留 text/image，base64 图片透传", () => {
    const out = toPiContent([
      { type: "text", text: "a" },
      { type: "image", mimeType: "image/png", data: "BASE64" },
      { type: "text", text: "b" },
    ]);
    expect(out).toEqual([
      { type: "text", text: "a" },
      { type: "image", mimeType: "image/png", data: "BASE64" },
      { type: "text", text: "b" },
    ]);
  });
});
