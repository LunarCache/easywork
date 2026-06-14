/**
 * 文档分块：标题/段落感知的递归切分 + 重叠（参考 Unsloth rag/chunking.py 思路）。
 * 无外部 tokenizer，按字符近似 token 预算（中文偏保守）。
 */

export interface Chunk {
  text: string;
  index: number;
}

const SEPARATORS = ["\n# ", "\n## ", "\n### ", "\n\n", "\n", "。", ". ", " "];

/** 近似 token 数（1 token ≈ 4 字符英文 / 1.5 字符中文，取折中 3）。 */
function approxTokens(s: string): number {
  return Math.ceil(s.length / 3);
}

function splitOn(text: string, sep: string): string[] {
  if (sep === "") return text.split("");
  // 保留分隔符在前段尾部，避免丢标题标记
  const parts: string[] = [];
  let rest = text;
  let idx = rest.indexOf(sep);
  while (idx >= 0) {
    parts.push(rest.slice(0, idx + sep.length));
    rest = rest.slice(idx + sep.length);
    idx = rest.indexOf(sep);
  }
  if (rest) parts.push(rest);
  return parts;
}

function recursiveSplit(text: string, maxTokens: number, sepIdx: number): string[] {
  if (approxTokens(text) <= maxTokens) return [text];
  if (sepIdx >= SEPARATORS.length) {
    // 兜底：按字符硬切
    const out: string[] = [];
    const charBudget = maxTokens * 3;
    for (let i = 0; i < text.length; i += charBudget) out.push(text.slice(i, i + charBudget));
    return out;
  }
  const pieces = splitOn(text, SEPARATORS[sepIdx]!);
  if (pieces.length === 1) return recursiveSplit(text, maxTokens, sepIdx + 1);
  // 贪心合并相邻片段到预算内
  const merged: string[] = [];
  let cur = "";
  for (const p of pieces) {
    if (approxTokens(cur + p) > maxTokens && cur) {
      merged.push(cur);
      cur = p;
    } else {
      cur += p;
    }
    // 单片仍超预算 → 继续递归细分
    if (approxTokens(cur) > maxTokens) {
      for (const sub of recursiveSplit(cur, maxTokens, sepIdx + 1)) merged.push(sub);
      cur = "";
    }
  }
  if (cur) merged.push(cur);
  return merged;
}

export function chunkText(
  text: string,
  opts: { maxTokens?: number; overlapTokens?: number } = {},
): Chunk[] {
  const maxTokens = opts.maxTokens ?? 350;
  const overlap = opts.overlapTokens ?? 50;
  const norm = text.replace(/\r\n/g, "\n").trim();
  if (!norm) return [];
  const raw = recursiveSplit(norm, maxTokens, 0)
    .map((t) => t.trim())
    .filter(Boolean);
  // 加入重叠：每块前缀拼上前一块尾部 overlap token 的内容
  const chunks: Chunk[] = [];
  const overlapChars = overlap * 3;
  for (let i = 0; i < raw.length; i++) {
    let body = raw[i]!;
    if (i > 0 && overlapChars > 0) {
      const prev = raw[i - 1]!;
      body = `${prev.slice(Math.max(0, prev.length - overlapChars))}\n${body}`;
    }
    chunks.push({ text: body, index: i });
  }
  return chunks;
}
