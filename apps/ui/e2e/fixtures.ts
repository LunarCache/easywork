import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test as base, expect } from "@playwright/test";
import { EasyWorkClient } from "@ew/sdk";

interface DaemonInfo {
  baseUrl: string;
  token: string;
  pid: number;
}

interface E2eContext {
  dataDir: string;
  workspaceDir: string;
  info: DaemonInfo;
  client: EasyWorkClient;
  openApp: (opts?: { resetStorage?: boolean }) => Promise<void>;
}

async function waitForDaemon(proc: ChildProcessWithoutNullStreams): Promise<DaemonInfo> {
  return await new Promise<DaemonInfo>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`daemon 启动超时\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 30_000);

    const cleanup = () => {
      clearTimeout(timer);
      proc.stdout.off("data", onStdout);
      proc.stderr.off("data", onStderr);
      proc.off("exit", onExit);
      proc.off("error", onError);
    };

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const line = stdout.split(/\r?\n/, 1)[0]?.trim();
      if (!line) return;
      try {
        const info = JSON.parse(line) as DaemonInfo;
        settle(() => resolve(info));
      } catch {
        /* 继续等首行 JSON */
      }
    };
    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      settle(() => reject(new Error(`daemon 提前退出 code=${code} signal=${signal}\nstdout:\n${stdout}\nstderr:\n${stderr}`)));
    };
    const onError = (error: Error) => settle(() => reject(error));

    proc.stdout.on("data", onStdout);
    proc.stderr.on("data", onStderr);
    proc.on("exit", onExit);
    proc.on("error", onError);
  });
}

async function killProcessTree(proc: ChildProcessWithoutNullStreams): Promise<void> {
  const pid = proc.pid;
  if (!pid) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  try {
    process.kill(pid, 0);
    process.kill(pid, "SIGKILL");
  } catch {
    /* ignore */
  }
}

export const test = base.extend<E2eContext>({
  dataDir: async ({}, use) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ew-playwright-"));
    try {
      await use(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },

  workspaceDir: async ({ dataDir }, use) => {
    const dir = path.join(dataDir, "workspace-fixture");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "README.md"), "# E2E Workspace\n");
    await use(dir);
  },

  info: async ({ dataDir }, use) => {
    const cliPath = path.resolve(process.cwd(), "apps/daemon/dist/cli.js");
    const token = `ew-e2e-${randomUUID()}`;
    const proc = spawn(process.execPath, [cliPath, "serve", "--host", "127.0.0.1", "--token", token], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        EW_DATA_DIR: dataDir,
        EW_PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const info = await waitForDaemon(proc);
    try {
      await use(info);
    } finally {
      await killProcessTree(proc);
    }
  },

  client: async ({ info }, use) => {
    await use(new EasyWorkClient({ baseUrl: info.baseUrl, token: info.token }));
  },

  openApp: async ({ page, info }, use) => {
    await use(async (opts?: { resetStorage?: boolean }) => {
      const url = new URL("/", `http://127.0.0.1:${Number(process.env.EW_E2E_UI_PORT ?? 4173)}`);
      url.searchParams.set("baseUrl", info.baseUrl);
      url.searchParams.set("token", info.token);
      if (opts?.resetStorage !== false) {
        await page.context().clearCookies();
        await page.goto(url.toString());
        await page.evaluate(() => {
          localStorage.clear();
          sessionStorage.clear();
        });
      }
      await page.goto(url.toString());
      await expect(page.getByTestId("sidebar-settings")).toBeVisible();
    });
  },
});

export { expect };
