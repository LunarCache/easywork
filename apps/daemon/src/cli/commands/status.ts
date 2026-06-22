import { connectExisting, pidAlive, readInfo } from "../daemon.js";
import { c, out } from "../term.js";

export async function status(): Promise<void> {
  const conn = await connectExisting();
  if (!conn) {
    const stale = readInfo();
    if (stale && pidAlive(stale.pid)) {
      out(c.yellow(`daemon 进程在（pid ${stale.pid}）但 /health 无应答 — 可能正在启动或已卡死`));
    } else {
      out(c.dim("daemon 未运行"));
    }
    process.exitCode = 1;
    return;
  }
  const { client, info } = conn;
  out(`${c.green("●")} daemon 运行中`);
  out(`  ${c.dim("地址")}  ${info.baseUrl}`);
  if (info.pid) out(`  ${c.dim("pid ")}  ${info.pid}`);
  try {
    const models = await client.listModels();
    out(`  ${c.dim("模型")}  ${models.routed.length ? models.routed.join(", ") : c.dim("（无）")}`);
    if (models.endpoints?.length) {
      out(`  ${c.dim("端点")}  ${models.endpoints.map((e) => e.baseUrl).join(", ")}`);
    }
  } catch {
    /* 模型列举失败不致命 */
  }
}

export async function stop(): Promise<void> {
  const info = readInfo();
  if (!info || !info.pid) {
    out(c.dim("没有可停止的本机 daemon（无 daemon.json）"));
    return;
  }
  if (!pidAlive(info.pid)) {
    out(c.dim(`daemon 进程已不在（pid ${info.pid}）`));
    return;
  }
  try {
    process.kill(info.pid, "SIGTERM");
    out(c.green(`已发送 SIGTERM 给 daemon（pid ${info.pid}）`));
  } catch (e) {
    out(c.red(`停止失败: ${(e as Error).message}`));
    process.exitCode = 1;
  }
}
