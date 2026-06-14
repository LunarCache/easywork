import { z } from "zod";
import { defineTool } from "@ew/tools";
import type { MemoryLayer, MemoryProvider, Tool } from "@ew/shared";

/**
 * 各全局层字符上限（参考 Hermes：USER.md 1375 / MEMORY.md 2200）。
 * 接近上限时 add/replace 报错，逼模型合并或删旧条目，而非静默膨胀。
 */
const LAYER_CAP: Record<"user-profile" | "agent-memory" | "skills", number> = {
  "user-profile": 1375,
  "agent-memory": 2200,
  skills: 2200,
};

const MANAGED_LAYERS = ["user-profile", "agent-memory", "skills"] as const;

/**
 * manage_memory 工具（参考 Hermes：模型自治、有界的长期记忆）。
 * 模型主动 add/replace/remove 持久事实到分层 markdown（user-profile/agent-memory/skills）。
 * replace/remove 用子串定位已有条目（无需全文）。与被动 LLM 抽取互补。
 */
export function makeMemoryTool(memory: MemoryProvider): Tool {
  return defineTool({
    name: "manage_memory",
    description:
      "管理你的长期记忆（跨会话持久）。add 新增事实；replace 用子串定位并改写已有条目；remove 删除。分层：user-profile=用户身份/偏好，agent-memory=你应记住的客观事实/约定，skills=可复用流程。每层有字符上限，满了需先合并/删除。",
    schema: z.object({
      action: z.enum(["add", "replace", "remove"]).describe("操作"),
      layer: z.enum(MANAGED_LAYERS).describe("目标分层"),
      text: z.string().optional().describe("add 的新内容 / replace 的替换内容"),
      match: z.string().optional().describe("replace/remove 用于定位已有条目的子串"),
    }),
    requiresApproval: "never",
    async run({ action, layer, text, match }) {
      const ml = layer as MemoryLayer;
      const items = await memory.list({ layer: ml });

      if (action === "add") {
        const t = (text ?? "").trim();
        if (!t) return err("add 需要 text。");
        const cap = LAYER_CAP[layer];
        const used = items.reduce((n, it) => n + it.text.length, 0);
        if (used + t.length > cap) {
          return err(
            `${layer} 已用 ${used}/${cap} 字符，新增后超限。请先用 remove 删除过时条目或 replace 合并重叠条目，再重试。`,
          );
        }
        const w = await memory.write({ layer: ml, text: t });
        return ok(`已记入 ${layer}（${used + t.length}/${cap}）：${t}`, { id: w.id });
      }

      // replace / remove 需要 match 定位
      const m = (match ?? "").trim();
      if (!m) return err(`${action} 需要 match（用于定位已有条目的子串）。`);
      const found = items.filter((it) => it.text.includes(m));
      if (found.length === 0) return err(`未找到包含「${m}」的 ${layer} 条目。`);
      if (found.length > 1) {
        return err(
          `「${m}」匹配到 ${found.length} 条 ${layer} 条目（${found.map((f) => `"${f.text.slice(0, 24)}…"`).join("、")}），请用更精确的 match。`,
        );
      }
      const target = found[0]!;

      if (action === "remove") {
        await memory.delete(target.id);
        return ok(`已从 ${layer} 删除：${target.text}`);
      }

      // replace
      const t = (text ?? "").trim();
      if (!t) return err("replace 需要 text（替换内容）。");
      const cap = LAYER_CAP[layer];
      const used = items.reduce((n, it) => n + it.text.length, 0) - target.text.length;
      if (used + t.length > cap) {
        return err(`${layer} 替换后超限（${used + t.length}/${cap}）。请精简内容或删除其他条目。`);
      }
      const e = await memory.edit(target.id, { text: t });
      return ok(`已更新 ${layer}：${t}`, { id: e.id });
    },
  });
}

function ok(content: string, display?: Record<string, unknown>): {
  content: string;
  display?: unknown;
} {
  return display ? { content, display: { kind: "memory", ...display } } : { content };
}

function err(content: string): { content: string; isError: true } {
  return { content, isError: true };
}
