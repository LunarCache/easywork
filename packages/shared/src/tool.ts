import { z } from "zod";
import { ContentPartSchema } from "./message.js";

/** JSON Schema（工具/函数参数）。运行时不深校验，留给各工具自行用 zod 校验。 */
export const JsonSchemaSchema = z.record(z.string(), z.unknown());
export type JsonSchema = Record<string, unknown>;

/** 暴露给模型的工具定义（函数调用）。 */
export const ToolDefinitionSchema = z.object({
  name: z.string(),
  description: z.string(),
  parameters: JsonSchemaSchema,
});
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

export const ToolSourceSchema = z.enum(["builtin", "mcp", "skill"]);
export type ToolSource = z.infer<typeof ToolSourceSchema>;

/** 工具执行结果。content 喂回模型；display 是更丰富的 UI 载荷（不进模型）。 */
export const ToolResultSchema = z.object({
  content: z.union([z.string(), z.array(ContentPartSchema)]),
  isError: z.boolean().optional(),
  display: z.unknown().optional(),
});
export type ToolResult = z.infer<typeof ToolResultSchema>;

/**
 * 审批策略。危险工具（代码执行/终端）默认 "always" 或 "first-use"。
 * 谓词形式在运行时由 registry 解析，不进 schema。
 */
export const ApprovalPolicySchema = z.enum(["never", "always", "first-use"]);
export type ApprovalPolicy = z.infer<typeof ApprovalPolicySchema> | ((args: unknown) => boolean);

export type ApprovalVerdict = "approve" | "approve-always" | "deny";

export type ApprovalVerdictResult = "approve" | "approve-always" | "deny";

/** 审批门：危险工具执行前征询（UI 弹窗 / IM 确认 / 自动策略）。 */
export interface ApprovalGate {
  request(req: {
    toolName: string;
    args: unknown;
    rationale?: string;
  }): Promise<ApprovalVerdictResult>;
}

/** 工具执行上下文。 */
export interface ToolExecContext {
  sessionId: string;
  /** 沙箱工作目录（代码/终端/技能脚本的 cwd）。 */
  workspaceDir: string;
  signal: AbortSignal;
  approval: ApprovalGate;
  /** 向 UI/渠道发送中间进度（可选）。 */
  emit?: (event: { type: string; [k: string]: unknown }) => void;
}

/** 一个 agent 可调用的工具。内置工具、MCP 工具、Skills 都归一成它。 */
export interface Tool {
  definition: ToolDefinition;
  source: ToolSource;
  requiresApproval: ApprovalPolicy;
  execute(args: unknown, ctx: ToolExecContext): Promise<ToolResult>;
}

/** 动态工具来源（MCP / Skills 每轮刷新）。 */
export interface ToolProvider {
  tools(ctx: ToolExecContext): Promise<Tool[]>;
}

/** 判断工具是否需要审批。 */
export function needsApproval(policy: ApprovalPolicy, args: unknown, firstUse: boolean): boolean {
  if (typeof policy === "function") return policy(args);
  if (policy === "never") return false;
  if (policy === "always") return true;
  return firstUse; // "first-use"
}

/** 工具调用去重的规范键：name + 排序后稳定序列化的参数。 */
export function canonicalToolCallKey(name: string, rawArguments: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArguments || "{}");
  } catch {
    parsed = rawArguments;
  }
  return `${name}:${stableStringify(parsed)}`;
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}
