import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const WIN = process.platform === "win32";
// 本地推理运行时 = llama.app 的统一 `llama`（router 模式所需，经 `llama serve` 起服务，三端统一）。
// 经典每模型一进程的 `llama-server` 已不再支持（仅统一 `llama`）。
const BIN_NAME = WIN ? "llama.exe" : "llama";

/** 候选目录：PATH + llama.app 安装位置（~/.local/bin）+ 常见包管理路径（GUI 应用 PATH 往往很少）。 */
function candidateDirs(): string[] {
  const home = os.homedir();
  const fromPath = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const extra = WIN
    ? [path.join(home, ".local", "bin")]
    : [path.join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];
  return [...fromPath, ...extra];
}

function isExecutable(p: string): boolean {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    return WIN || (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** llama.app 官方安装脚本（统一 llama 二进制 → ~/.local/bin/llama）。 */
export const LLAMA_INSTALL = {
  unix: "curl -LsSf https://llama.app/install.sh | sh",
  windows: "irm https://llama.app/install.ps1 | iex",
} as const;

/**
 * 解析统一 `llama`（llama.app）二进制路径：`EW_LLAMA_BIN` 显式 → 候选目录里的 `llama`。
 * 返回可执行文件路径（裸名交给 PATH 自行解析）或 undefined（未安装，交由上层引导经 llama.app 安装）。
 */
export function resolveLlamaBin(explicit?: string): string | undefined {
  if (explicit) {
    // 含分隔符/绝对路径：存在才用。裸名：交给 PATH（spawn 自行解析）。
    if (explicit.includes("/") || explicit.includes("\\") || path.isAbsolute(explicit)) {
      return isExecutable(explicit) ? explicit : undefined;
    }
    return explicit;
  }
  for (const dir of candidateDirs()) {
    const p = path.join(dir, BIN_NAME);
    if (isExecutable(p)) return p;
  }
  return undefined;
}
