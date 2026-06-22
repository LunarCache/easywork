import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { dataDir } from "@ew/core";
import { EasyWorkClient } from "@ew/sdk";
import { selfServeArgs } from "./env.js";

export interface DaemonInfo {
  baseUrl: string;
  token: string;
  pid: number;
}

export function infoPath(): string {
  return path.join(dataDir(), "daemon.json");
}

/** 读取本机 daemon 发现文件（不保证进程还活着）。 */
export function readInfo(): DaemonInfo | null {
  try {
    return JSON.parse(fs.readFileSync(infoPath(), "utf8")) as DaemonInfo;
  } catch {
    return null;
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** HTTP 探活：daemon.json 可能是上次崩溃残留，唯一可靠判据是 /health 应答。 */
async function httpAlive(baseUrl: string): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(`${baseUrl}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

function makeClient(info: DaemonInfo): EasyWorkClient {
  return new EasyWorkClient({ baseUrl: info.baseUrl, token: info.token });
}

function spawnDaemon(): void {
  const child = spawn(process.execPath, selfServeArgs(["serve"]), {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface EnsureOptions {
  /** 探不到活着的 daemon 时是否自动拉起一个（默认 true）。 */
  autostart?: boolean;
  /** 自启后等待就绪的超时（毫秒）。 */
  timeoutMs?: number;
}

/**
 * 拿到一个连上活 daemon 的 client。
 * - `EW_BASEURL` 存在 → 直连该地址（远端模式，绝不自启）。
 * - 否则读 `daemon.json` 探活；死了且 autostart → detached spawn 自己 `serve`，轮询到就绪。
 */
export async function ensureDaemon(opts: EnsureOptions = {}): Promise<EasyWorkClient> {
  const { autostart = true, timeoutMs = 20000 } = opts;

  const envBase = process.env.EW_BASEURL;
  if (envBase) {
    const baseUrl = envBase.replace(/\/$/, "");
    if (!(await httpAlive(baseUrl))) {
      throw new Error(`EW_BASEURL 指向的 daemon 无应答: ${baseUrl}`);
    }
    return makeClient({ baseUrl, token: process.env.EW_TOKEN ?? "", pid: 0 });
  }

  const info = readInfo();
  if (info && (await httpAlive(info.baseUrl))) return makeClient(info);

  if (!autostart) {
    throw new Error("daemon 未运行。先执行 `easywork serve`，或设 EW_BASEURL 直连。");
  }

  spawnDaemon();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(250);
    const cur = readInfo();
    if (cur && (await httpAlive(cur.baseUrl))) return makeClient(cur);
  }
  throw new Error(`自启 daemon 超时（${timeoutMs}ms）。试 \`easywork serve\` 看启动日志。`);
}

/** 仅在已有活 daemon 时返回 client，绝不自启（status/stop 用）。 */
export async function connectExisting(): Promise<{ client: EasyWorkClient; info: DaemonInfo } | null> {
  const envBase = process.env.EW_BASEURL;
  if (envBase) {
    const baseUrl = envBase.replace(/\/$/, "");
    if (await httpAlive(baseUrl)) {
      const info = { baseUrl, token: process.env.EW_TOKEN ?? "", pid: 0 };
      return { client: makeClient(info), info };
    }
    return null;
  }
  const info = readInfo();
  if (info && (await httpAlive(info.baseUrl))) return { client: makeClient(info), info };
  return null;
}
