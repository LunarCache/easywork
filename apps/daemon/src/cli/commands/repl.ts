import { randomUUID } from "node:crypto";
import type { ChatMessage } from "@ew/shared";
import { ensureDaemon } from "../daemon.js";
import { pickModel, resolveProject, runTurn } from "../agent.js";
import { c, err, out, question } from "../term.js";

export interface ReplFlags {
  model?: string;
  workspace?: string;
  yes?: boolean;
}

/** 交互式多轮对话。/exit 退出，/reset 新开会话，/model 切模型。 */
export async function repl(flags: ReplFlags): Promise<void> {
  const client = await ensureDaemon();
  let model = await pickModel(client, flags.model);
  const projectId = flags.workspace ? await resolveProject(client, flags.workspace) : undefined;

  let threadId = randomUUID();
  const history: ChatMessage[] = [];

  out(c.dim(`EasyWork REPL · 模型 ${model}${projectId ? " · workspace" : ""}`));
  out(c.dim("命令: /exit 退出 · /reset 新会话 · /model <id> 换模型 · /help"));

  for (;;) {
    const line = await question(c.cyan("› "));
    if (!line) continue;

    if (line.startsWith("/")) {
      const [cmd, ...rest] = line.slice(1).split(/\s+/);
      const arg = rest.join(" ");
      if (cmd === "exit" || cmd === "quit" || cmd === "q") break;
      if (cmd === "reset") {
        threadId = randomUUID();
        history.length = 0;
        out(c.dim("已新开会话"));
        continue;
      }
      if (cmd === "model") {
        if (!arg) {
          out(c.dim(`当前模型: ${model}`));
        } else {
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

    history.push({ role: "user", content: line });
    const res = await runTurn(client, { model, threadId, history, projectId, autoApprove: flags.yes });
    if (res.message) history.push(res.message);
    else if (res.error) history.pop(); // 本轮失败，回退用户消息以免脏 history
  }
  out(c.dim("再见 👋"));
}
