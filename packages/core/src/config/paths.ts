import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/**
 * 数据目录解析。桌面下由 Electron 注入 EW_DATA_DIR（app.getPath('userData')）；
 * 无头/CLI 下回落到 ~/.easywork。
 */
export function dataDir(): string {
  const dir = process.env.EW_DATA_DIR || path.join(os.homedir(), ".easywork");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function modelsDir(): string {
  const dir = path.join(dataDir(), "models");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function memoryDir(): string {
  const dir = path.join(dataDir(), "memory");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function dbPath(): string {
  return path.join(dataDir(), "easywork.db");
}
