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

/** 默认工作区根：用户未选择本地目录时，在数据目录下用一个专门目录承载。 */
export function defaultWorkspaceDir(): string {
  const dir = path.join(dataDir(), "workspace");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 对话模式的「每会话」工件目录：<workspace>/chats/<threadId>。
 * 让每条聊天会话的产出（文件/网页/构建物）相互隔离，便于右侧工件面板按会话展示。
 * 仅计算路径、不创建目录（首次写入时由 /agent/run 懒建）；threadId 经清洗防路径穿越。
 */
export function chatWorkspaceDir(threadId: string): string {
  const safe = threadId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "default";
  return path.join(defaultWorkspaceDir(), "chats", safe);
}

export function dbPath(): string {
  return path.join(dataDir(), "easywork.db");
}
