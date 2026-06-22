import type { LocalLoadOptions } from "@ew/shared";
import type { LocalEndpoint } from "./net.js";

/**
 * 本地推理后端的对外接口（app.ts / session-host 依赖此抽象）。
 * 当前唯一实现 = `RouterServerManager`（llama serve router 模式）。
 */
export interface LocalBackend {
  load(opts: LocalLoadOptions): Promise<{ id: string; contextSize: number }>;
  unload(id: string): Promise<void>;
  /** 已加载/已路由模型的内部 baseUrl（恒回环）；非本地模型返回 undefined。 */
  baseUrlFor(modelId: string): string | undefined;
  getBindHost(): string;
  getApiKey(): string | undefined;
  setBindHost(host: string): Promise<void>;
  applyNet(opts: { bindHost?: string; apiKey?: string | undefined }): Promise<void>;
  setBinaryPath(p: string | undefined): void;
  binaryPathOf(): string | undefined;
  endpoints(): LocalEndpoint[];
  /** 模型 id → 上下文窗口（供 UI 进度环分母）。 */
  contexts(): Record<string, number>;
  loadedIds(): string[];
  stopAll(): Promise<void>;
}
