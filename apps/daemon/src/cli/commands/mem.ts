import { ensureDaemon } from "../daemon.js";
import { c, die, out } from "../term.js";

export async function memList(scope?: string): Promise<void> {
  const client = await ensureDaemon();
  const items = await client.listMemory(scope ? { scope } : {});
  if (!items.length) return out(c.dim("没有记忆条目"));
  for (const it of items) {
    const head = `${c.cyan(it.id.slice(0, 8))} ${c.dim(`[${it.layer}${it.scope ? `·${it.scope}` : ""}]`)}`;
    out(`${head}  ${it.text.replace(/\s+/g, " ").slice(0, 100)}`);
  }
}

export async function memSearch(query: string | undefined): Promise<void> {
  if (!query) die("用法: easywork mem search <关键词>");
  const client = await ensureDaemon();
  const hits = await client.recallMemory(query, 10);
  if (!hits.length) return out(c.dim("无召回结果"));
  for (const h of hits) {
    const score = h.score != null ? c.dim(`(${h.score.toFixed(2)}) `) : "";
    out(`${score}${c.dim(`[${h.layer}]`)} ${h.text.replace(/\s+/g, " ").slice(0, 120)}`);
  }
}

export async function memRemove(id: string | undefined): Promise<void> {
  if (!id) die("用法: easywork mem rm <id>");
  const client = await ensureDaemon();
  await client.deleteMemory(id);
  out(c.green(`✓ 已删除记忆 ${id.slice(0, 8)}`));
}
