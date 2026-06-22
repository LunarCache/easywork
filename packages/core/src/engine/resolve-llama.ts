import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** llama 推理运行时类型：经典 `llama-server`，或 llama.app 的统一 `llama`（用 `llama serve`）。 */
export type LlamaKind = "llama-server" | "llama";

export interface LlamaRuntime {
  /** 可执行文件绝对路径（或裸名，交给 PATH）。 */
  path: string;
  kind: LlamaKind;
}

const WIN = process.platform === "win32";
// 优先 llama.app 的统一 `llama`（router 模式所需；三端统一）；经典 `llama-server` 仅作探测兜底
// （后端只在 kind==="llama" 时启用 router；只有 llama-server 时上层提示安装统一 llama）。
const CANDIDATES: { name: string; kind: LlamaKind }[] = WIN
  ? [
      { name: "llama.exe", kind: "llama" },
      { name: "llama-server.exe", kind: "llama-server" },
    ]
  : [
      { name: "llama", kind: "llama" },
      { name: "llama-server", kind: "llama-server" },
    ];

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

/** 推断显式路径属于哪种运行时（按文件名）。 */
function kindOf(p: string): LlamaKind {
  return /(^|[\\/])llama-server(\.exe)?$/i.test(p) ? "llama-server" : "llama";
}

/**
 * 解析 llama 推理运行时：`EW_LLAMA_SERVER` 显式 → 候选目录里的统一 `llama`（llama.app）→ 经典 `llama-server`。
 * 返回 { path, kind } 或 undefined（未安装，交由上层引导经 llama.app 安装）。
 */
export function resolveLlamaRuntime(explicit?: string): LlamaRuntime | undefined {
  if (explicit) {
    // 含分隔符/绝对路径：存在才用。裸名：交给 PATH（spawn 自行解析），按文件名判类型。
    if (explicit.includes("/") || explicit.includes("\\") || path.isAbsolute(explicit)) {
      return isExecutable(explicit) ? { path: explicit, kind: kindOf(explicit) } : undefined;
    }
    return { path: explicit, kind: kindOf(explicit) };
  }
  const dirs = candidateDirs();
  for (const { name, kind } of CANDIDATES) {
    for (const dir of dirs) {
      const p = path.join(dir, name);
      if (isExecutable(p)) return { path: p, kind };
    }
  }
  return undefined;
}
