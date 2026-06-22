import readline from "node:readline";

/** stdout 是否接到了终端（管道 / 重定向时为 false，用于决定是否上色 / 渲染状态行）。 */
export const isTTY = Boolean(process.stdout.isTTY);
const useColor = isTTY && !process.env.NO_COLOR;

function wrap(code: number): (s: string) => string {
  return (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
}

export const c = {
  dim: wrap(2),
  bold: wrap(1),
  red: wrap(31),
  green: wrap(32),
  yellow: wrap(33),
  blue: wrap(34),
  magenta: wrap(35),
  cyan: wrap(36),
  gray: wrap(90),
};

export function out(s = ""): void {
  process.stdout.write(`${s}\n`);
}

export function err(s = ""): void {
  process.stderr.write(`${s}\n`);
}

export function die(msg: string, code = 1): never {
  err(c.red(`错误: ${msg}`));
  process.exit(code);
}

/** 单行问询（返回 trim 后的回答）。用于 REPL 输入 / 审批 y/n。 */
export async function question(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // Ctrl-C 直接退出整个 CLI（否则 readline 会吞掉 SIGINT）。
  rl.on("SIGINT", () => {
    rl.close();
    process.stdout.write("\n");
    process.exit(130);
  });
  try {
    const ans = await new Promise<string>((resolve) => rl.question(prompt, resolve));
    return ans.trim();
  } finally {
    rl.close();
  }
}
