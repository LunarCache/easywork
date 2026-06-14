/**
 * 极简 frontmatter 解析（无需 YAML 依赖）。支持：
 *   key: value
 *   key: [a, b]        内联数组
 *   key:               多行列表
 *     - a
 *     - b
 */
export interface ParsedFrontmatter {
  data: Record<string, string | string[]>;
  body: string;
}

export function parseFrontmatter(md: string): ParsedFrontmatter {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(md);
  if (!m) return { data: {}, body: md };
  const [, fm, body] = m;
  const data: Record<string, string | string[]> = {};
  const lines = fm!.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) {
      i++;
      continue;
    }
    const key = kv[1]!;
    const rest = kv[2]!.trim();
    if (rest === "") {
      // 可能跟随多行列表
      const items: string[] = [];
      let j = i + 1;
      while (j < lines.length && /^\s*-\s+/.test(lines[j]!)) {
        items.push(lines[j]!.replace(/^\s*-\s+/, "").trim());
        j++;
      }
      data[key] = items;
      i = j;
    } else if (rest.startsWith("[") && rest.endsWith("]")) {
      data[key] = rest
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      i++;
    } else {
      data[key] = stripQuotes(rest);
      i++;
    }
  }
  return { data, body: body ?? "" };
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}
