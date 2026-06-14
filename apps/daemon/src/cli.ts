import fs from "node:fs";
import path from "node:path";
import { createCore, dataDir } from "@ew/core";

interface Args {
  command: string;
  port?: number;
  host?: string;
  token?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { command: argv[0] ?? "serve" };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port" || a === "-p") args.port = Number(argv[++i]);
    else if (a === "--host" || a === "-H") args.host = argv[++i];
    else if (a === "--token") args.token = argv[++i];
  }
  return args;
}

async function serve(args: Args): Promise<void> {
  const token = args.token ?? process.env.EW_TOKEN;
  const core = createCore(token ? { token } : {});
  const { port, host } = await core.start({
    port: args.port ?? (Number(process.env.EW_PORT) || 0),
    host: args.host ?? process.env.EW_HOST,
  });

  // 把 endpoint + token 写到数据目录，供 Electron / 客户端发现。
  const infoPath = path.join(dataDir(), "daemon.json");
  const info = { baseUrl: `http://${host}:${port}`, token: core.token, pid: process.pid };
  fs.writeFileSync(infoPath, JSON.stringify(info, null, 2));

  // stdout 第一行打印 JSON，便于父进程（supervisor）解析。
  process.stdout.write(`${JSON.stringify(info)}\n`);
  console.error(`[easywork] core daemon listening on ${info.baseUrl}`);
  console.error(`[easywork] token: ${core.token}`);
  console.error(`[easywork] info written to ${infoPath}`);

  const shutdown = async () => {
    console.error("[easywork] shutting down...");
    await core.stop();
    try {
      fs.unlinkSync(infoPath);
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case "serve":
      await serve(args);
      break;
    default:
      console.error(`未知命令: ${args.command}\n用法: easywork serve [--port N] [--host H] [--token T]`);
      process.exit(1);
  }
}

void main();
