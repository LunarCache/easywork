import type { Tool, ToolDefinition, ToolExecContext, ToolProvider } from "@ew/shared";

/**
 * 工具注册表。内置工具静态注册；MCP / Skills 作为动态 ToolProvider 每轮刷新。
 * agent loop 每轮调用 list(ctx) 得到合并后的工具集（按 name 去重，静态优先）。
 */
export class ToolRegistry {
  private readonly staticTools = new Map<string, Tool>();
  private readonly providers = new Map<string, ToolProvider>();

  register(tool: Tool): void {
    this.staticTools.set(tool.definition.name, tool);
  }

  unregister(name: string): void {
    this.staticTools.delete(name);
  }

  addProvider(id: string, provider: ToolProvider): void {
    this.providers.set(id, provider);
  }

  removeProvider(id: string): void {
    this.providers.delete(id);
  }

  /** 合并静态工具 + 各 provider 的动态工具（name 去重，先到先得）。 */
  async list(ctx: ToolExecContext): Promise<Tool[]> {
    const byName = new Map<string, Tool>(this.staticTools);
    for (const provider of this.providers.values()) {
      let tools: Tool[] = [];
      try {
        tools = await provider.tools(ctx);
      } catch {
        tools = []; // provider 故障不影响整体（cooloff 由 provider 内部处理）
      }
      for (const t of tools) {
        if (!byName.has(t.definition.name)) byName.set(t.definition.name, t);
      }
    }
    return [...byName.values()];
  }

  async definitions(ctx: ToolExecContext): Promise<ToolDefinition[]> {
    return (await this.list(ctx)).map((t) => t.definition);
  }
}
