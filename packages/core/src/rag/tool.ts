import { z } from "zod";
import { defineTool } from "@ew/tools";
import type { Tool, ToolProvider } from "@ew/shared";
import type { KnowledgeBaseStore, RagHit } from "./store.js";

/** 把检索命中渲染成带引用标记的 <chunk> 块（喂回模型），并把来源放入 display。 */
export function formatHits(hits: RagHit[]): { content: string; display: unknown } {
  if (hits.length === 0) return { content: "知识库中未找到相关内容。", display: { kind: "citations", sources: [] } };
  const blocks = hits
    .map((h, i) => `<chunk id="${i + 1}" source="${escapeAttr(h.source)}">\n${h.text}\n</chunk>`)
    .join("\n");
  const sources = hits.map((h, i) => ({ id: i + 1, source: h.source, score: Number(h.score.toFixed(3)) }));
  return {
    content: `以下是知识库检索结果，请基于其作答并用 [来源 N] 标注引用：\n\n${blocks}`,
    display: { kind: "citations", sources },
  };
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, "&quot;");
}

/** search_knowledge_base 工具：从文档知识库检索。kbId 省略=跨全部集合。 */
export function makeSearchKnowledgeBaseTool(kb: KnowledgeBaseStore, kbId?: string): Tool {
  return defineTool({
    name: "search_knowledge_base",
    description: "在已上传的文档知识库中检索与问题相关的内容（语义+关键词混合检索）。",
    schema: z.object({
      query: z.string().describe("检索问题"),
      top_k: z.number().int().positive().optional().describe("返回片段数，默认 4"),
    }),
    requiresApproval: "never",
    async run({ query, top_k }) {
      const hits = await kb.retrieve(query, { topK: top_k ?? 4, ...(kbId ? { kbId } : {}) });
      const { content, display } = formatHits(hits);
      return { content, display };
    },
  });
}

/** 只有知识库非空时才暴露该工具的 ToolProvider（全集合）。 */
export function knowledgeBaseToolProvider(kb: KnowledgeBaseStore): ToolProvider {
  const tool = makeSearchKnowledgeBaseTool(kb);
  return {
    tools: async () => (kb.count() > 0 ? [tool] : []),
  };
}

/**
 * RAG 自动注入：首轮若知识库非空且最佳命中过相关度阈值，预检索并作为系统上下文注入，
 * 省去模型显式调用 search_knowledge_base（参考 Unsloth autoinject）。返回注入文本与来源，或 null。
 */
export async function ragAutoInject(
  kb: KnowledgeBaseStore,
  query: string,
  opts: { minScore?: number; topK?: number; kbId?: string } = {},
): Promise<{ context: string; sources: { id: number; source: string }[] } | null> {
  if (!query.trim() || kb.count(opts.kbId) === 0) return null;
  const hits = await kb.retrieve(query, {
    topK: opts.topK ?? 4,
    minScore: opts.minScore ?? 0.3,
    ...(opts.kbId ? { kbId: opts.kbId } : {}),
  });
  if (hits.length === 0) return null;
  const blocks = hits
    .map((h, i) => `<chunk id="${i + 1}" source="${h.source}">\n${h.text}\n</chunk>`)
    .join("\n");
  return {
    context: `知识库相关内容（供参考，引用时标 [来源 N]）：\n${blocks}`,
    sources: hits.map((h, i) => ({ id: i + 1, source: h.source })),
  };
}
