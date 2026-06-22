import { randomUUID } from "node:crypto";
import { ensureDaemon } from "../daemon.js";
import { pickModel, resolveProject, runTurn } from "../agent.js";
import { c, err, out, question } from "../term.js";

export interface ReplFlags {
  model?: string;
  workspace?: string;
  yes?: boolean;
  thread?: string;
}

/** 交互式多轮对话。/exit 退出，/reset 新开会话，/model 切模型。上下文由 daemon 按 threadId 持久化。 */
export async function repl(flags: ReplFlags): Promise<void> {
  const client = await ensureDaemon();
  let model = await pickModel(client, flags.model);
  const projectId = flags.workspace ? await resolveProject(client, flags.workspace) : undefined;

  let threadId = flags.thread || randomUUID();

  out(
    c.dim(
      `EasyWork REPL · 模型 ${model}${projectId ? " · workspace" : ""}${flags.thread ? ` · 续接 ${threadId.slice(0, 8)}` : ""}`,
    ),
  );
  out(c.dim("命令: /exit 退出 · /reset 新会话 · /model <id> 换模型 · /help · Ctrl-C 中断本轮"));

  for (;;) {
    const line = await question(c.cyan("› "));
    if (!line) continue;

    if (line.startsWith("/")) {
      const [cmd, ...rest] = line.slice(1).split(/\s+/);
      const arg = rest.join(" ");
      if (cmd === "exit" || cmd === "quit" || cmd === "q") break;
      if (cmd === "reset") {
        threadId = randomUUID();
        out(c.dim("已新开会话"));
        continue;
      }
      if (cmd === "model") {
        if (!arg) out(c.dim(`当前模型: ${model}`));
        else {
          model = arg;
          out(c.dim(`切换模型: ${model}`));
        }
        continue;
      }
      if (cmd === "help") {
        out(c.dim("/exit · /reset · /model <id> · /help"));
        continue;
      }
      err(c.red(`未知命令: /${cmd}`));
      continue;
    }

    // 每轮一个 AbortController：Ctrl-C 仅中断当前轮，不退出 REPL。
    const ac = new AbortController();
    const onSig = () => ac.abort();
    process.on("SIGINT", onSig);
    try {
      await runTurn(client, {
        model,
        threadId,
        history: [{ role: "user", content: line }],
        projectId,
        autoApprove: flags.yes,
        signal: ac.signal,
      });
    } finally {
      process.off("SIGINT", onSig);
    }
  }
  out(c.dim("再见 👋"));
}
