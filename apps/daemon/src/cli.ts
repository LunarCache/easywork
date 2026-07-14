import { VERSION, userArgv } from "./cli/env.js";
import { c, die, err, isTTY, out } from "./cli/term.js";
import { serve } from "./cli/commands/serve.js";
import { status, stop } from "./cli/commands/status.js";
import { modelsList, modelsPull, modelsRemove } from "./cli/commands/models.js";
import { run } from "./cli/commands/run.js";
import { repl } from "./cli/commands/repl.js";
import { threadList, threadRemove, threadShow } from "./cli/commands/thread.js";
import { memList, memRemove, memSearch } from "./cli/commands/mem.js";

interface Parsed {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

const ALIASES: Record<string, string> = {
  m: "model",
  H: "host",
  p: "port",
  w: "workspace",
  y: "yes",
  t: "thread",
  h: "help",
  v: "version",
};
const BOOLEAN = new Set(["yes", "help", "version"]);

function parse(argv: string[]): Parsed {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const name = ALIASES[key] ?? key;
      if (BOOLEAN.has(name)) flags[name] = true;
      else flags[name] = argv[++i] ?? "";
    } else if (a.startsWith("-") && a.length > 1) {
      const key = a.slice(1);
      const name = ALIASES[key] ?? key;
      if (BOOLEAN.has(name)) flags[name] = true;
      else flags[name] = argv[++i] ?? "";
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

function num(v: string | boolean | undefined): number | undefined {
  return typeof v === "string" && v ? Number(v) : undefined;
}
function str(v: string | boolean | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

const HELP = `${c.bold("easywork")} — 本地 AI 工作台 CLI  ${c.dim(`v${VERSION}`)}

${c.bold("用法")}  easywork <命令> [参数] [选项]

${c.bold("命令")}
  ${c.cyan("repl")}                     交互式多轮对话（无命令 + 终端时的默认）
  ${c.cyan("run")} <提问>               一次性问答，流式输出后退出（支持管道 stdin）
  ${c.cyan("models")} [ls]              列出已路由 + 本地模型
  ${c.cyan("models pull")} <hf-repo>    下载 GGUF 模型（--quant 指定量化）
  ${c.cyan("models rm")} <名/路径片段>  删除本地模型
  ${c.cyan("thread")} [ls]              列出会话；${c.cyan("thread show")} <id> 看历史；${c.cyan("thread rm")} <id> 删除
  ${c.cyan("mem")} [ls]                 列记忆；${c.cyan("mem search")} <词> 召回；${c.cyan("mem rm")} <id> 删除
  ${c.cyan("serve")}                    前台启动 core daemon
  ${c.cyan("status")}                   查看 daemon 状态（地址 / pid / 模型）
  ${c.cyan("stop")}                     停止本机 daemon

${c.bold("选项")}
  -m, --model <id>         指定模型（默认 EW_MODEL 或第一个已路由模型）
  -w, --workspace <dir>    在该项目目录里跑 agent（读写文件 / 跑命令）
  -t, --thread <id>        run/repl 续接已有会话（默认每次新开）
  -y, --yes                自动批准工具调用 / 跳过删除确认（脚本用）
      --quant <q>          models pull 的量化（如 Q4_K_M）
      --scope <s>          mem ls 限定作用域
  -p, --port / -H, --host / --token   serve 用
  -h, --help / -v, --version

${c.bold("环境")}
  EW_BASEURL / EW_TOKEN    直连远端 daemon（设了则不自动拉起本机 daemon）
  EW_MODEL                 默认模型

${c.dim("无活动 daemon 时，run/repl/models/status 之外的命令会自动在后台拉起一个。")}`;

async function main(): Promise<void> {
  const { positionals, flags } = parse(userArgv());
  const command = positionals[0];

  if (flags.version) {
    out(VERSION);
    return;
  }
  if (flags.help && !command) {
    out(HELP);
    return;
  }

  switch (command) {
    case undefined:
      if (isTTY)
        await repl({
          model: str(flags.model),
          workspace: str(flags.workspace),
          yes: !!flags.yes,
          thread: str(flags.thread),
        });
      else out(HELP);
      break;
    case "help":
      out(HELP);
      break;
    case "serve":
      await serve({ port: num(flags.port), host: str(flags.host), token: str(flags.token) });
      break;
    case "status":
      await status();
      break;
    case "stop":
      await stop();
      break;
    case "models": {
      const sub = positionals[1] ?? "ls";
      if (sub === "ls" || sub === "list") await modelsList();
      else if (sub === "pull" || sub === "download")
        await modelsPull(positionals[2], str(flags.quant));
      else if (sub === "rm" || sub === "remove" || sub === "delete")
        await modelsRemove(positionals[2], !!flags.yes);
      else die(`未知 models 子命令: ${sub}（支持 ls / pull / rm）`);
      break;
    }
    case "thread":
    case "threads": {
      const sub = positionals[1] ?? "ls";
      if (sub === "ls" || sub === "list") await threadList();
      else if (sub === "show" || sub === "cat") await threadShow(positionals[2]);
      else if (sub === "rm" || sub === "remove" || sub === "delete")
        await threadRemove(positionals[2], !!flags.yes);
      else die(`未知 thread 子命令: ${sub}（支持 ls / show / rm）`);
      break;
    }
    case "mem":
    case "memory": {
      const sub = positionals[1] ?? "ls";
      if (sub === "ls" || sub === "list") await memList(str(flags.scope));
      else if (sub === "search" || sub === "recall")
        await memSearch(positionals.slice(2).join(" "));
      else if (sub === "rm" || sub === "remove" || sub === "delete")
        await memRemove(positionals[2]);
      else die(`未知 mem 子命令: ${sub}（支持 ls / search / rm）`);
      break;
    }
    case "run":
      await run(positionals.slice(1).join(" "), {
        model: str(flags.model),
        workspace: str(flags.workspace),
        yes: !!flags.yes,
        thread: str(flags.thread),
      });
      break;
    case "repl":
    case "chat":
      await repl({
        model: str(flags.model),
        workspace: str(flags.workspace),
        yes: !!flags.yes,
        thread: str(flags.thread),
      });
      break;
    default:
      err(c.red(`未知命令: ${command}`));
      err(`运行 ${c.cyan("easywork --help")} 查看用法`);
      process.exit(1);
  }
}

main().catch((e: unknown) => {
  err(c.red(`错误: ${e instanceof Error ? e.message : String(e)}`));
  process.exit(1);
});
