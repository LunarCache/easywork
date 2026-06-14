import type { ZodType } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ApprovalPolicy, Tool, ToolExecContext, ToolResult, ToolSource } from "@ew/shared";

export interface DefineToolSpec<T> {
  name: string;
  description: string;
  schema: ZodType<T>;
  source?: ToolSource;
  requiresApproval?: ApprovalPolicy;
  run(args: T, ctx: ToolExecContext): Promise<ToolResult> | ToolResult;
}

/** 用 zod schema 定义一个 Tool：自动生成 JSON Schema 参数 + 入参校验。 */
export function defineTool<T>(spec: DefineToolSpec<T>): Tool {
  const parameters = zodToJsonSchema(spec.schema, { target: "openApi3" }) as Record<string, unknown>;
  // 去掉 $schema 等顶层噪声，保留 type/properties/required。
  delete parameters.$schema;
  return {
    definition: { name: spec.name, description: spec.description, parameters },
    source: spec.source ?? "builtin",
    requiresApproval: spec.requiresApproval ?? "never",
    async execute(rawArgs, ctx) {
      const parsed = spec.schema.safeParse(rawArgs ?? {});
      if (!parsed.success) {
        return { content: `参数校验失败: ${parsed.error.message}`, isError: true };
      }
      return spec.run(parsed.data, ctx);
    },
  };
}
