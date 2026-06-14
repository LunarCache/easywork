// 采样参数按「模型」保存（每模型独立覆盖）；Agent 配置全局。均持久化到 localStorage。

export interface Sampling {
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  repeatPenalty?: number;
  maxTokens?: number;
}

export interface AgentPrefs {
  maxIterations?: number;
}

const SAMPLING_KEY = "ew.sampling"; // Record<modelId, Sampling>
const AGENT_KEY = "ew.agent";

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

export function loadAgentPrefs(): AgentPrefs {
  try {
    const raw = localStorage.getItem(AGENT_KEY);
    return raw ? (JSON.parse(raw) as AgentPrefs) : {};
  } catch {
    return {};
  }
}

export function saveAgentPrefs(p: AgentPrefs): void {
  try {
    localStorage.setItem(AGENT_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
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
