import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const prefixArgs = args.flatMap((arg, index) => arg === "--prefix-arg" ? [args[index + 1]].filter(Boolean) : []);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultExecutable = path.join(
  root,
  "apps/daemon/dist-sea",
  process.platform === "win32" ? "easywork.exe" : "easywork",
);
const executable = path.resolve(valueAfter("--executable") ?? defaultExecutable);
let stderr = "";

if (!fs.existsSync(executable)) {
  console.error(`SEA daemon 不存在: ${executable}`);
  process.exit(1);
}
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ew-sea-smoke-"));

const child = spawn(executable, [
  ...prefixArgs,
  "serve",
  "--port",
  "0",
  "--host",
  "127.0.0.1",
  "--token",
  "sea-smoke",
], {
  env: { ...process.env, EW_DATA_DIR: dataDir, NO_COLOR: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

function waitForStartup(timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    const timer = setTimeout(() => reject(new Error(`SEA daemon 启动超时\n${stderr}`)), timeoutMs);
    const finish = (fn, value) => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
      fn(value);
    };
    const onData = (chunk) => {
      stdout += chunk.toString();
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const info = JSON.parse(line);
          if (typeof info.baseUrl === "string" && typeof info.token === "string") {
            finish(resolve, info);
            return;
          }
        } catch {
          /* daemon 的非 JSON 日志忽略。 */
        }
      }
    };
    const onError = (error) => finish(reject, error);
    const onExit = (code) => finish(reject, new Error(`SEA daemon 提前退出 (${code ?? "signal"})\n${stderr}`));
    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function stopChild() {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 500))]);
}

try {
  const info = await waitForStartup();
  const response = await fetch(`${info.baseUrl}/health`, { signal: globalThis.AbortSignal.timeout(5_000) });
  const health = await response.json();
  if (!response.ok || health?.ok !== true || health?.name !== "easywork-core") {
    throw new Error(`SEA daemon /health 无效: ${response.status} ${JSON.stringify(health)}`);
  }
  console.log(`✓ SEA daemon smoke 通过: ${info.baseUrl}/health`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await stopChild();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
