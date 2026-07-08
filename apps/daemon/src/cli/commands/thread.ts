import { ensureDaemon } from "../daemon.js";
import { c, die, isTTY, out, question } from "../term.js";

export async function threadList(): Promise<void> {
  const client = await ensureDaemon();
  const threads = await client.listThreads();
  if (!threads.length) return out(c.dim("没有会话"));
  for (const t of threads) {
    const when = t.updatedAt.replace("T", " ").slice(0, 16);
    const tag = t.projectId ? c.magenta(" [ws]") : t.channel ? c.yellow(" [im]") : "";
    out(`${c.cyan(t.id.slice(0, 8))}  ${c.dim(when)}  ${t.title || c.dim("（无标题）")}${tag}`);
  }
}

export async function threadShow(id: string | undefined): Promise<void> {
  if (!id) die("用法: easywork thread show <id>");
  const client = await ensureDaemon();
  const msgs = await client.threadMessages(id);
  if (!msgs.length) return out(c.dim("（空会话或 id 不存在）"));
  for (const m of msgs) {
    const text = m.parts
      .filter((p): p is Extract<(typeof m.parts)[number], { type: "text" }> => p.type === "text" && !!p.text)
      .map((p) => p.text)
      .join("");
    const role =
      m.role === "user" ? c.cyan("你") : m.role === "assistant" ? c.green("AI") : c.dim(m.role);
    if (text.trim()) out(`${role}: ${text.trim()}`);
    for (const tc of m.toolCalls ?? []) out(c.dim(`  ⚙ ${tc.name}`));
    out("");
  }
}

export async function threadRemove(id: string | undefined, yes?: boolean): Promise<void> {
  if (!id) die("用法: easywork thread rm <id> [-y]");
  const client = await ensureDaemon();
  if (!yes && isTTY) {
    const ans = (await question(`删除会话 ${c.cyan(id.slice(0, 8))}? [y/N]: `)).toLowerCase();
    if (ans !== "y" && ans !== "yes") return out(c.dim("已取消"));
  }
  await client.deleteThread(id);
  out(c.green(`✓ 已删除会话 ${id.slice(0, 8)}`));
}
