// Agent 配置全局偏好。模型采样参数由 daemon 的本地模型设置持久化。

import type { ThinkLevel } from "@ew/shared";

// 思考档位按「模型」保存。fallback 来自模型能力：推理模型对齐 pi 默认 medium，其余 off。
const THINK_KEY = "ew.think"; // Record<modelId, ThinkLevel>
export function loadThink(model: string, fallback: ThinkLevel = "off"): ThinkLevel {
  if (!model) return fallback;
  try {
    const raw = localStorage.getItem(THINK_KEY);
    const map = raw ? (JSON.parse(raw) as Record<string, ThinkLevel>) : {};
    return map[model] ?? fallback;
  } catch {
    return fallback;
  }
}
export function saveThink(model: string, level: ThinkLevel): void {
  if (!model) return;
  try {
    const raw = localStorage.getItem(THINK_KEY);
    const map = raw ? (JSON.parse(raw) as Record<string, ThinkLevel>) : {};
    map[model] = level;
    localStorage.setItem(THINK_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

// 被禁用的 Skill 名称（按名传给 runAgent.excludeSkills，过滤 pi 发现的 skills）。
const DISABLED_SKILLS_KEY = "ew.disabledSkills";
export function loadDisabledSkills(): string[] {
  try {
    const raw = localStorage.getItem(DISABLED_SKILLS_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}
export function saveDisabledSkills(names: string[]): void {
  try {
    localStorage.setItem(DISABLED_SKILLS_KEY, JSON.stringify(names));
  } catch {
    /* ignore */
  }
}

// ---------- 外观（"Agent Tasks"：明暗 + 跟随系统 + 强调色），持久化到 localStorage ----------

/** 明暗：浅色 / 深色 / 跟随系统。 */
export type Appearance = "light" | "dark" | "system";
/** 强调色字段仅为旧偏好兼容；实际颜色由明暗主题 token 决定。 */
export type Accent = "blue";
export interface ThemePrefs {
  appearance: Appearance;
  accent: Accent;
}

const THEME_KEY = "ew.theme";
const THEME_DEFAULT: ThemePrefs = { appearance: "light", accent: "blue" };
const APPEARANCES: readonly Appearance[] = ["light", "dark", "system"];

export function loadThemePrefs(): ThemePrefs {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    if (!raw) return { ...THEME_DEFAULT };
    const p = JSON.parse(raw) as Partial<ThemePrefs>;
    return {
      appearance: p.appearance && APPEARANCES.includes(p.appearance) ? p.appearance : THEME_DEFAULT.appearance,
      accent: "blue",
    };
  } catch {
    return { ...THEME_DEFAULT };
  }
}

export function saveThemePrefs(p: ThemePrefs): void {
  try {
    localStorage.setItem(THEME_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

/** 把外观偏好应用到 <html>：明暗 data-theme（跟随系统时按 prefers-color-scheme）。 */
export function applyTheme(p: ThemePrefs): void {
  const root = document.documentElement;
  const prefersDark =
    typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
  const dark = p.appearance === "dark" || (p.appearance === "system" && prefersDark);
  root.setAttribute("data-theme", dark ? "dark" : "light");
}
