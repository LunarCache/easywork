// 斜杠命令（composer 输入「/」弹自动补全）：纯解析/匹配逻辑，UI 在 components/SlashPalette.tsx。
import type { ThinkLevel } from "@ew/shared";

export interface SlashCmd {
  name: string;
  /** 参数提示（无参命令省略）。 */
  arg?: string;
  desc: string;
}

export const SLASH_CMDS: SlashCmd[] = [
  { name: "think", arg: "off|low|medium|high", desc: "切换思考档位" },
  { name: "model", arg: "模型名", desc: "切换模型" },
  { name: "compact", desc: "压缩上下文" },
];

/** 思考档位循环顺序（= 候选）。 */
export const THINK_LEVELS: ThinkLevel[] = ["off", "low", "medium", "high"];
/** 思考档位中文短标签（composer 控件显示）。 */
export const THINK_LABEL: Record<ThinkLevel, string> = { off: "关", low: "低", medium: "中", high: "高" };
/** 循环到下一档（关→低→中→高→关）。 */
export function nextThink(level: ThinkLevel): ThinkLevel {
  return THINK_LEVELS[(THINK_LEVELS.indexOf(level) + 1) % THINK_LEVELS.length]!;
}

/** 文本是否处于斜杠命令态：单行、以「/」开头。返回「/」后的内容（可能含空格=命令+参数），否则 null。 */
export function slashQuery(text: string): string | null {
  if (!text.startsWith("/") || text.includes("\n")) return null;
  return text.slice(1);
}

/** 拆出命令名 + 参数（去掉前导「/」）。 */
export function parseCmd(text: string): { name: string; arg: string } {
  const body = text.replace(/^\//, "");
  const sp = body.indexOf(" ");
  if (sp === -1) return { name: body.toLowerCase(), arg: "" };
  return { name: body.slice(0, sp).toLowerCase(), arg: body.slice(sp + 1).trim() };
}

/** 命令名阶段（未输空格）：按前缀过滤候选命令。 */
export function matchCmds(name: string): SlashCmd[] {
  const n = name.toLowerCase();
  return SLASH_CMDS.filter((c) => c.name.startsWith(n));
}
