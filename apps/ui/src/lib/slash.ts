// 斜杠命令（composer 输入「/」弹自动补全）：纯解析/匹配逻辑，UI 在 components/SlashPalette.tsx。
import type { ThinkLevel } from "@ew/shared";

export interface SlashCmd {
  name: string;
  /** 参数提示（无参命令省略）。 */
  arg?: string;
  desc: string;
}

export const SLASH_CMDS: SlashCmd[] = [
  { name: "model", arg: "来源 / 模型", desc: "先选模型来源，再切换当前会话模型" },
  { name: "skill", arg: "技能名", desc: "手动调用一个 Skill" },
  { name: "think", arg: "off|low|medium|high", desc: "调整思考强度" },
  { name: "compact", desc: "压缩上下文" },
];

/** 思考档位循环顺序（= 候选）。 */
export const THINK_LEVELS: ThinkLevel[] = ["off", "low", "medium", "high"];
export const THINK_META: Record<ThinkLevel, { label: string; hint: string }> = {
  off: { label: "关", hint: "更快，适合短问答" },
  low: { label: "低", hint: "轻推理，保持响应速度" },
  medium: { label: "中", hint: "默认强度，兼顾速度与质量" },
  high: { label: "高", hint: "深推理，适合复杂任务" },
};
/** 思考档位中文短标签（composer 控件显示）。 */
export const THINK_LABEL: Record<ThinkLevel, string> = Object.fromEntries(
  Object.entries(THINK_META).map(([k, v]) => [k, v.label]),
) as Record<ThinkLevel, string>;
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

/** 显式 /skill:name 调用的 skill 名；用于发送时允许手动调用已关闭的自动 Skill。 */
export function explicitSkillName(text: string): string | null {
  return /^\/skill:([^\s]+)/i.exec(text.trimStart())?.[1] ?? null;
}

/** 命令名阶段（未输空格）：按前缀过滤候选命令。 */
export function matchCmds(name: string): SlashCmd[] {
  const n = name.toLowerCase();
  return SLASH_CMDS.filter((c) => c.name.startsWith(n));
}
