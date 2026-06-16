import type { ChatMessage, InferenceEngine, MemoryLayer } from "@ew/shared";
import { isWorkspaceScope, messageText } from "@ew/shared";
import type { ExtractedFact, FactExtractor } from "@ew/memory";

/** 对话/全局作用域：关于「用户这个人」。 */
const GLOBAL_PROMPT = `你是记忆抽取器。从对话中抽取值得长期保存的【持久事实】，忽略一次性、临时、与任务无关或闲聊的内容。
分层：
- user-profile：用户的身份/角色/长期偏好（如"用户是后端工程师"、"偏好简洁回答"、"习惯用中文交流"）。
- agent-memory：助手应跨会话记住的客观事实或约定（如"天气查询用 open-meteo"）。
- skills：用户教给助手的可复用操作流程或技巧。
规则：
- 只输出真正持久、明确的事实；不确定就不要输出。
- 不要输出"已有记忆"里已存在或语义等价的条目。
- 每条事实简洁成句、自包含（不要"它/这个/上面"等指代）。
- 没有可抽取的内容就返回空数组。
严格只输出 JSON，形如：{"facts":[{"layer":"user-profile|agent-memory|skills","text":"..."}]}`;

/** 工作区作用域：关于「这个工程」。 */
const WORKSPACE_PROMPT = `你是工程记忆抽取器。从这段工作中抽取对【后续在本工程里干活】有长期价值的要点，忽略一次性、过程性、闲聊内容。
分层：
- conventions：本工程特定的约定/约束/偏好（如"用 npm 不用 pnpm"、"必须兼容 Node 26"、"不要改 unsloth/ 目录"）。
- decisions：做过的关键变动/决策——记「做了什么 + 为什么」的摘要，不要记代码 diff（diff 由 git 保存）。
- pitfalls：踩过的坑/教训及规避方法（如"X 接口在并发下会错配，须串行化"）。
规则：
- 只输出对将来有复用价值、明确的要点；不确定就不要输出。
- 不要输出"已有记忆"里已存在或语义等价的条目。
- 每条简洁成句、自包含（不要"它/这个/上面"等指代）。
- 没有可抽取的内容就返回空数组。
严格只输出 JSON，形如：{"facts":[{"layer":"conventions|decisions|pitfalls","text":"..."}]}`;

export interface FactExtractorDeps {
  /** 解析 model id → 引擎（通常是 EngineRegistry.resolve）。 */
  resolveEngine: (model: string) => InferenceEngine;
  /** 抽取补全的最大 token（默认 512）。 */
  maxTokens?: number;
}

/**
 * 用对话模型做 LLM 事实抽取。复用当轮已加载的模型，避免额外加载。
 * 模型未路由 / 无 model / 解析失败时安全返回 []，记忆降级为仅启发式摘要。
 */
export function buildFactExtractor(deps: FactExtractorDeps): FactExtractor {
  return async ({ messages, existing, layers, scope, model }) => {
    if (!model) return [];
    let engine: InferenceEngine;
    try {
      engine = deps.resolveEngine(model);
    } catch {
      return []; // 模型未路由 → 跳过抽取
    }
    const convo = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map(
        (m) =>
          `${m.role === "user" ? "用户" : "助手"}: ${messageText(m.content as ChatMessage["content"])}`,
      )
      .filter((l) => l.trim().length > 3)
      .join("\n");
    if (!convo.trim()) return [];

    const existingText = existing.length
      ? existing.map((e) => `[${e.layer}] ${e.text}`).join("\n")
      : "（无）";
    const systemPrompt = isWorkspaceScope(scope) ? WORKSPACE_PROMPT : GLOBAL_PROMPT;
    const chatMessages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `已有记忆：\n${existingText}\n\n对话：\n${convo}\n\n抽取持久要点，按要求输出 JSON。`,
      },
    ];

    const res = await engine.chat({
      model,
      messages: chatMessages,
      temperature: 0,
      maxTokens: deps.maxTokens ?? 512,
      responseFormat: { type: "json_object" },
    });
    return parseFacts(messageText(res.message.content), layers);
  };
}

/** 解析模型输出为事实列表：截出 JSON 对象 → 校验 layer（须在本作用域允许集内）/text。 */
function parseFacts(raw: string, layers: readonly MemoryLayer[]): ExtractedFact[] {
  const json = extractJsonObject(raw);
  if (!json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const facts = (parsed as { facts?: unknown }).facts;
  if (!Array.isArray(facts)) return [];
  const out: ExtractedFact[] = [];
  for (const f of facts) {
    if (!f || typeof f !== "object") continue;
    const layer = (f as { layer?: unknown }).layer;
    const text = (f as { text?: unknown }).text;
    if (typeof text !== "string" || !text.trim()) continue;
    if (typeof layer !== "string" || !layers.includes(layer as MemoryLayer)) continue;
    out.push({ layer: layer as MemoryLayer, text: text.trim() });
  }
  return out;
}

/** 从可能含围栏/前后缀的文本里截出第一个括号平衡的 JSON 对象（转义字符串感知）。 */
function extractJsonObject(s: string): string | null {
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
    } else if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}
