/**
 * 自愈 tool-call 解析与剥离。移植自参考 `tool_healing.py`（unsloth），
 * 保持行为一致：大括号平衡 + 字符串转义感知；XML function/parameter 闭合标签可选；
 * name 字符类含 `-`（MCP 命名空间 mcp__srv__list-issues 依赖）。
 */

export interface ParsedToolCall {
  id: string;
  name: string;
  /** 始终是 JSON 字符串。 */
  arguments: string;
}

// 闭合块（已闭合的工具调用）。DOTALL → [\s\S]。
function closedPatterns(): RegExp[] {
  return [
    /<tool_call>[\s\S]*?<\/tool_call>/g,
    /<function=[\w-]+>[\s\S]*?<\/function>/g,
  ];
}
// 全部（含未闭合的尾部块）。
function allPatterns(): RegExp[] {
  return [
    ...closedPatterns(),
    /<tool_call>[\s\S]*$/g,
    /<function=[\w-]+>[\s\S]*$/g,
  ];
}

const TC_JSON_START_RE = /<tool_call>\s*\{/g;
const TC_FUNC_START_RE = /<function=([\w-]+)>\s*/g;
const TC_FUNC_CLOSE_RE = /\s*<\/function>\s*$/;
const TC_PARAM_START_RE = /<parameter=([\w-]+)>\s*/g;
const TC_PARAM_CLOSE_RE = /\s*<\/parameter>\s*$/;

interface Match {
  index: number;
  end: number;
  group1?: string;
}

function findAll(re: RegExp, s: string): Match[] {
  const out: Match[] = [];
  const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  let m: RegExpExecArray | null;
  while ((m = r.exec(s)) !== null) {
    out.push({ index: m.index, end: m.index + m[0].length, group1: m[1] });
    if (m.index === r.lastIndex) r.lastIndex++; // 防零宽死循环
  }
  return out;
}

/**
 * 从文本中解析 tool calls。
 * 支持：
 *   <tool_call>{"name":"web_search","arguments":{"query":"..."}}</tool_call>
 *   <function=web_search><parameter=query>...</parameter></function>
 * 闭合标签（</tool_call> </function> </parameter>）均可选。
 */
export function parseToolCallsFromText(content: string): ParsedToolCall[] {
  const toolCalls: ParsedToolCall[] = [];

  // 模式 1：<tool_call> 内的 JSON。平衡大括号提取，跳过字符串内的大括号。
  for (const m of findAll(TC_JSON_START_RE, content)) {
    const braceStart = m.end - 1; // 开括号 { 的位置
    let depth = 0;
    let i = braceStart;
    let inString = false;
    while (i < content.length) {
      const ch = content[i]!;
      if (inString) {
        if (ch === "\\" && i + 1 < content.length) {
          i += 2;
          continue;
        }
        if (ch === '"') inString = false;
      } else if (ch === '"') {
        inString = true;
      } else if (ch === "{") {
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
      i += 1;
    }
    if (depth === 0) {
      const jsonStr = content.slice(braceStart, i + 1);
      try {
        const obj = JSON.parse(jsonStr) as { name?: string; arguments?: unknown };
        let args = obj.arguments ?? {};
        if (typeof args !== "string") args = JSON.stringify(args);
        toolCalls.push({ id: `call_${toolCalls.length}`, name: obj.name ?? "", arguments: args as string });
      } catch {
        /* 跳过坏 JSON */
      }
    }
  }

  // 模式 2：XML 风格 <function=name><parameter=key>value</parameter></function>
  // 仅当模式 1 无结果时启用。
  if (toolCalls.length === 0) {
    const funcStarts = findAll(TC_FUNC_START_RE, content);
    for (let idx = 0; idx < funcStarts.length; idx++) {
      const fm = funcStarts[idx]!;
      const funcName = fm.group1 ?? "";
      const bodyStart = fm.end;
      const nextFunc = idx + 1 < funcStarts.length ? funcStarts[idx + 1]!.index : content.length;
      const endTagRel = content.slice(bodyStart).indexOf("</tool_call>");
      let bodyEnd = endTagRel >= 0 ? bodyStart + endTagRel : content.length;
      bodyEnd = Math.min(bodyEnd, nextFunc);
      let body = content.slice(bodyStart, bodyEnd);
      body = body.replace(TC_FUNC_CLOSE_RE, ""); // 去尾部 </function>

      const args: Record<string, string> = {};
      const paramStarts = findAll(TC_PARAM_START_RE, body);
      if (paramStarts.length === 1) {
        const pm = paramStarts[0]!;
        let val = body.slice(pm.end);
        val = val.replace(TC_PARAM_CLOSE_RE, "");
        args[pm.group1 ?? ""] = val.trim();
      } else {
        for (let pidx = 0; pidx < paramStarts.length; pidx++) {
          const pm = paramStarts[pidx]!;
          const valStart = pm.end;
          const nextParam = pidx + 1 < paramStarts.length ? paramStarts[pidx + 1]!.index : body.length;
          let val = body.slice(valStart, nextParam);
          val = val.replace(TC_PARAM_CLOSE_RE, "");
          args[pm.group1 ?? ""] = val.trim();
        }
      }
      toolCalls.push({ id: `call_${toolCalls.length}`, name: funcName, arguments: JSON.stringify(args) });
    }
  }

  return toolCalls;
}

/**
 * 剥离 tool-call XML 标记。
 * final=false：只移除完全闭合的块（流式中安全输出已闭合之外的文本）。
 * final=true：连同尾部未闭合块一并移除，并 trim。
 */
export function stripToolCallMarkup(text: string, opts: { final?: boolean } = {}): string {
  const patterns = opts.final ? allPatterns() : closedPatterns();
  let out = text;
  for (const pat of patterns) out = out.replace(pat, "");
  return opts.final ? out.trim() : out;
}
