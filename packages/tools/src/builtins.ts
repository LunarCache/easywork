import { z } from "zod";
import type { Tool } from "@ew/shared";
import { defineTool } from "./define.js";
import { safeFetch } from "./ssrf.js";

/** 当前时间。 */
export const getTimeTool = defineTool({
  name: "get_time",
  description: "获取当前日期与时间（ISO 8601）。",
  schema: z.object({ timezone: z.string().optional().describe("IANA 时区，如 Asia/Shanghai") }),
  run({ timezone }) {
    const now = new Date();
    let text: string;
    try {
      text = timezone
        ? now.toLocaleString("en-US", { timeZone: timezone })
        : now.toISOString();
    } catch {
      text = now.toISOString();
    }
    return { content: text };
  },
});

/** 安全计算器：仅允许数字与基础运算符。 */
const SAFE_EXPR = /^[0-9+\-*/%.()\s]+$/;
export const calculatorTool = defineTool({
  name: "calculator",
  description: "计算一个算术表达式（仅支持 + - * / % () 与数字）。",
  schema: z.object({ expression: z.string().describe("如 (3 + 4) * 2") }),
  run({ expression }) {
    if (!SAFE_EXPR.test(expression)) {
      return { content: "表达式含非法字符（仅允许数字与 + - * / % ( )）。", isError: true };
    }
    try {
      // 受限字符集后用 Function 求值；不暴露任何作用域。
      const fn = new Function(`"use strict"; return (${expression});`);
      const result = fn();
      if (typeof result !== "number" || !Number.isFinite(result)) {
        return { content: "结果非有限数。", isError: true };
      }
      return { content: String(result) };
    } catch (e) {
      return { content: `计算失败: ${e instanceof Error ? e.message : String(e)}`, isError: true };
    }
  },
});

/** HTTP GET：抓取一个 URL 的文本（截断）。涉及网络，首次使用需审批。 */
export const httpGetTool = defineTool({
  name: "http_get",
  description: "对一个 http(s) URL 发起 GET 请求，返回文本内容（截断到 8000 字符）。",
  schema: z.object({ url: z.string().url() }),
  requiresApproval: "first-use",
  async run({ url }, ctx) {
    if (!/^https?:\/\//.test(url)) return { content: "仅支持 http(s) URL。", isError: true };
    try {
      const res = await safeFetch(url, { signal: ctx.signal });
      const text = await res.text();
      const truncated = text.length > 8000 ? `${text.slice(0, 8000)}…[截断]` : text;
      return { content: `HTTP ${res.status}\n\n${truncated}` };
    } catch (e) {
      return { content: `请求失败: ${e instanceof Error ? e.message : String(e)}`, isError: true };
    }
  },
});

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Web 探索 + 取页（仿 Unsloth：query 搜 DuckDuckGo；url 直接取页正文）。
 * 由 UI 的「联网」开关门控。
 */
export const exploreWebTool = defineTool({
  name: "explore_web",
  description:
    "搜索网络并获取页面内容。给 query 返回搜索结果摘要；给 url 则抓取该页正文（用于读取搜索结果里的某个页面）。",
  schema: z.object({
    query: z.string().optional().describe("搜索查询"),
    url: z.string().optional().describe("要抓取正文的 URL（替代搜索）"),
    max_results: z.number().int().min(1).max(10).default(5).describe("最多返回的搜索结果数，1-10，默认 5"),
  }),
  requiresApproval: "never",
  async run({ query, url, max_results }, ctx) {
    const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36";
    // 取页模式
    if (url && url.trim()) {
      try {
        const res = await safeFetch(url.trim(), { signal: ctx.signal, headers: { "user-agent": ua } });
        const text = stripHtml(await res.text());
        return { content: text.length > 8000 ? `${text.slice(0, 8000)}…[截断]` : text || "(空白页)" };
      } catch (e) {
        return { content: `抓取失败: ${e instanceof Error ? e.message : String(e)}`, isError: true };
      }
    }
    if (!query || !query.trim()) return { content: "未提供查询。", isError: true };
    try {
      const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query.trim())}`, {
        signal: ctx.signal,
        headers: { "user-agent": ua },
      });
      const html = await res.text();
      const titles = [...html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
      const snips = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)];
      const results = titles.slice(0, max_results).map((t, i) => {
        let href = t[1]!;
        const uddg = /[?&]uddg=([^&]+)/.exec(href);
        if (uddg) href = decodeURIComponent(uddg[1]!);
        return { title: stripHtml(t[2] ?? ""), url: href, snippet: stripHtml(snips[i]?.[1] ?? "") };
      });
      if (results.length === 0) return { content: "没有搜索结果。" };
      const text = results.map((r) => `标题: ${r.title}\nURL: ${r.url}\n摘要: ${r.snippet}`).join("\n\n---\n\n");
      return {
        content: `${text}\n\n---\n\n注意：以上仅为摘要。要读取完整页面，用 url 参数再次调用 explore_web。`,
        display: results,
      };
    } catch (e) {
      return { content: `搜索失败: ${e instanceof Error ? e.message : String(e)}`, isError: true };
    }
  },
});

export const builtinTools: Tool[] = [
  getTimeTool,
  calculatorTool,
  httpGetTool,
  exploreWebTool,
];
