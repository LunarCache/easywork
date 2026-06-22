import fs from "node:fs";
import { createCore } from "@ew/core";
import { infoPath } from "../daemon.js";

export interface ServeFlags {
  port?: number;
  host?: string;
  token?: string;
}

/** 起 core daemon（Fastify HTTP/SSE/`/v1`），把发现信息写盘 + 打到 stdout 首行。 */
export async function serve(flags: ServeFlags): Promise<void> {
  const token = flags.token ?? process.env.EW_TOKEN;
  const core = createCore(token ? { token } : {});
  const { port, host } = await core.start({
    port: flags.port ?? (Number(process.env.EW_PORT) || 0),
    host: flags.host ?? process.env.EW_HOST,
  });

  const ip = infoPath();
  const info = { baseUrl: `http://${host}:${port}`, token: core.token, pid: process.pid };
  fs.writeFileSync(ip, JSON.stringify(info, null, 2));

  // stdout 第一行打印 JSON，便于父进程（supervisor / 自启的 CLI）解析。
  process.stdout.write(`${JSON.stringify(info)}\n`);
  console.error(`[easywork] core daemon listening on ${info.baseUrl}`);
  console.error(`[easywork] token: ${core.token}`);
  console.error(`[easywork] info written to ${ip}`);

  const shutdown = async () => {
    console.error("[easywork] shutting down...");
    await core.stop();
    try {
      fs.unlinkSync(ip);
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
