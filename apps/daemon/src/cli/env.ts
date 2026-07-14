// 构建期注入（见 tsup.config.ts / tsup.sea.config.ts 的 define）。
declare const __EW_VERSION__: string;
declare const __EW_SEA__: boolean;

/** 是否运行在 Node SEA 单文件二进制里。SEA 的 argv 无脚本路径，真实参数从 argv[1] 起。 */
export const IS_SEA: boolean = typeof __EW_SEA__ !== "undefined" ? __EW_SEA__ : false;

export const VERSION: string = typeof __EW_VERSION__ !== "undefined" ? __EW_VERSION__ : "0.0.0";

/** 去掉 runner（node + 脚本，或 SEA 可执行）后的用户参数。 */
export function userArgv(): string[] {
  if (!IS_SEA) return process.argv.slice(2);
  const args = process.argv.slice(1);
  // Node SEA 的 argv 形态随运行时版本有两种：
  // [exe, ...args] 或 [exe, exe, ...args]。只在重复项确为当前可执行文件时剔除。
  return args[0] === process.execPath ? args.slice(1) : args;
}

/** 自启 daemon 时 spawn 自己的参数：SEA 直接传子命令；dev 走 `node <script> serve`。 */
export function selfServeArgs(extra: string[]): string[] {
  return IS_SEA ? extra : [process.argv[1] ?? "", ...extra];
}
