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
  // 用 JSON Schema draft-7（numeric exclusiveMinimum）而非 openApi3——后者把 .positive()/.int() 等
  // 译成布尔 exclusiveMinimum:true（draft-4 风格），严格的 provider（DeepSeek 等）校验工具 schema 时
  // 报 "true is not of type number" 而 400，导致整轮空输出。draft-7 是 OpenAI/Anthropic/llama.cpp 通用。
  const parameters = zodToJsonSchema(spec.schema, { target: "jsonSchema7" }) as Record<string, unknown>;
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
