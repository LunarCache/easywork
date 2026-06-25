// 采样参数按「模型」保存（每模型独立覆盖）；Agent 配置全局。均持久化到 localStorage。

import type { ThinkLevel } from "@ew/shared";

export interface Sampling {
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  repeatPenalty?: number;
  maxTokens?: number;
}

const SAMPLING_KEY = "ew.sampling"; // Record<modelId, Sampling>

function readMap(): Record<string, Sampling> {
  try {
    const raw = localStorage.getItem(SAMPLING_KEY);
    return raw ? (JSON.parse(raw) as Record<string, Sampling>) : {};
  } catch {
    return {};
  }
}

/** 取某模型的采样覆盖。 */
export function loadSampling(model: string): Sampling {
  if (!model) return {};
  return readMap()[model] ?? {};
}

/** 保存某模型的采样覆盖（空对象=清除）。 */
export function saveSampling(model: string, s: Sampling): void {
  if (!model) return;
  try {
    const map = readMap();
    if (Object.keys(s).length === 0) delete map[model];
    else map[model] = s;
    localStorage.setItem(SAMPLING_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}


// 思考档位按「模型」保存（每模型独立；默认 off——云端思考更慢更贵，本地开一次即记住）。
const THINK_KEY = "ew.think"; // Record<modelId, ThinkLevel>
export function loadThink(model: string): ThinkLevel {
  if (!model) return "off";
  try {
    const raw = localStorage.getItem(THINK_KEY);
    const map = raw ? (JSON.parse(raw) as Record<string, ThinkLevel>) : {};
    return map[model] ?? "off";
  } catch {
    return "off";
  }
}
export function saveThink(model: string, level: ThinkLevel): void {
  if (!model) return;
  try {
    const raw = localStorage.getItem(THINK_KEY);
    const map = raw ? (JSON.parse(raw) as Record<string, ThinkLevel>) : {};
    if (level === "off") delete map[model];
    else map[model] = level;
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
/** 强调色固定为 blue（已移除主题色切换，仅保留黑白明暗）。 */
export type Accent = "blue";
export interface ThemePrefs {
  appearance: Appearance;
  accent: Accent;
}

const THEME_KEY = "ew.theme";
const THEME_DEFAULT: ThemePrefs = { appearance: "dark", accent: "blue" };
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

/** 采样对象 → runAgent 的 sampling 字段（仅含已设置项）。 */
export function samplingToRequest(s: Sampling): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of ["temperature", "topP", "topK", "minP", "repeatPenalty", "maxTokens"] as const) {
    const v = s[k];
    if (v != null && !Number.isNaN(v)) out[k] = v;
  }
  return out;
}
