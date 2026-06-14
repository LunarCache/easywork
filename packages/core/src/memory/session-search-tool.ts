import { z } from "zod";
import { defineTool } from "@ew/tools";
import { messageText, type ConversationRepo, type Tool } from "@ew/shared";

/**
 * session_search 工具（参考 Hermes：直接查会话 DB，不经 LLM 摘要、不丢信息）。
 * 三种用法：
 * - 给 query → 跨会话全文搜索（FTS5），可用 thread_id 限定单会话；
 * - 只给 thread_id → 浏览该会话最近消息（翻看上下文）；
 * - 都不给 → 列出最近会话。
 */
export function makeSessionSearchTool(repo: ConversationRepo): Tool {
  return defineTool({
    name: "session_search",
    description:
      "检索历史会话（完整对话存档，含工具调用）。给 query 做全文搜索；只给 thread_id 浏览该会话；都不给则列最近会话。用于回忆过往讨论/决定。",
    schema: z.object({
      query: z.string().optional().describe("全文搜索关键词（≥3 字符）"),
      thread_id: z.string().optional().describe("限定/浏览的会话 id"),
      limit: z.number().int().positive().optional().describe("返回条数，默认 10"),
    }),
    requiresApproval: "never",
    async run({ query, thread_id, limit }) {
      const max = limit ?? 10;
      // 1) 全文搜索
      if (query && query.trim()) {
        const hits = repo.searchMessages(query, {
          limit: max,
          ...(thread_id ? { threadId: thread_id } : {}),
        });
        if (hits.length === 0) {
          return { content: `未找到与「${query}」相关的历史消息。`, display: { kind: "session_search", hits: [] } };
        }
        const lines = hits.map(
          (h) =>
            `- [${h.role}] 《${h.threadTitle}》(thread=${h.threadId} seq=${h.seq})\n  ${h.snippet}`,
        );
        return {
          content: `历史会话命中（${hits.length}）：\n${lines.join("\n")}`,
          display: { kind: "session_search", hits },
        };
      }
      // 2) 浏览单个会话
      if (thread_id) {
        const msgs = repo.history(thread_id, max);
        if (msgs.length === 0) return { content: `会话 ${thread_id} 无消息或不存在。` };
        const lines = msgs.map((m) => `- [${m.role}] ${truncate(messageText(m.parts), 200)}`);
        return {
          content: `会话 ${thread_id} 最近 ${msgs.length} 条：\n${lines.join("\n")}`,
          display: { kind: "session_messages", threadId: thread_id, messages: msgs },
        };
      }
      // 3) 列最近会话
      const threads = repo.listThreads().slice(0, max);
      if (threads.length === 0) return { content: "暂无历史会话。" };
      const lines = threads.map((t) => `- 《${t.title}》(thread=${t.id}, 更新于 ${t.updatedAt})`);
      return {
        content: `最近会话（${threads.length}）：\n${lines.join("\n")}`,
        display: { kind: "thread_list", threads },
      };
    },
  });
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
