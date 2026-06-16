import { z } from "zod";
import { defineTool } from "@ew/tools";
import { visibleScopes, type MemoryItem, type MemoryProvider, type Tool } from "@ew/shared";

/**
 * recall_memory 工具——渐进式披露的「按需加载」端（借鉴 Skill：清单常驻、正文按需）。
 * 系统提示词里已注入记忆清单（标题）；模型需要某条细节或想按主题语义检索时调用本工具取全文。
 * 按会话可见作用域检索（工作区会话额外含全局 user-profile）。
 */
export function makeRecallMemoryTool(memory: MemoryProvider, scope: string): Tool {
  const views = visibleScopes(scope);
  return defineTool({
    name: "recall_memory",
    description:
      "检索你的长期记忆全文。系统提示词里已列出记忆清单（仅标题/要点）；当你需要某条的完整内容、或想按主题语义搜索记忆时，用本工具。",
    schema: z.object({
      query: z.string().describe("检索关键词或问题（语义检索）"),
      limit: z.number().int().positive().optional().describe("返回条数，默认 6"),
    }),
    requiresApproval: "never",
    async run({ query, limit }) {
      const topK = limit ?? 6;
      const all: MemoryItem[] = [];
      for (const v of views) {
        const hits = await memory.recall({ query, scope: v.scope, layers: [...v.layers], topK, minScore: 0 });
        all.push(...hits);
      }
      const byId = new Map<string, MemoryItem>();
      for (const h of all) if (!byId.has(h.id)) byId.set(h.id, h);
      const merged = [...byId.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, topK);
      if (merged.length === 0) return { content: `没有与「${query}」相关的记忆。` };
      const lines = merged.map((m) => `- [${m.layer}] ${m.text}`);
      return {
        content: `相关记忆（${merged.length}）：\n${lines.join("\n")}`,
        display: { kind: "memory-recall", items: merged.map((m) => ({ layer: m.layer, text: m.text, score: m.score })) },
      };
    },
  });
}
