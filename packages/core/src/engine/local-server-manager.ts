import net from "node:net";
import path from "node:path";
import { LlamaServerEngine } from "@ew/providers";
import type { InferenceEngine, LocalLoadOptions } from "@ew/shared";
import type { EngineRegistry } from "./registry.js";

/** 取一个空闲 TCP 端口。 */
export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** 已加载的本地模型 = 一个 llama-server 子进程 + 一个 LlamaServerEngine。 */
interface LocalHandle {
  id: string;
  engine: InferenceEngine & { start(): Promise<void>; stop(): Promise<void> };
  contextSize: number;
  lastUsed: number;
  host: string;
  port: number;
}

export interface LocalEngineLike extends InferenceEngine {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface LocalServerManagerOptions {
  binaryPath?: string;
  /** 引擎工厂（默认 LlamaServerEngine；测试可注入）。 */
  makeEngine?: (id: string, opts: LocalLoadOptions & { port: number; binaryPath?: string }) => LocalEngineLike;
  /** 最大常驻模型数；超出按 LRU 卸载。默认 env EW_MAX_LOADED_MODELS 或 3。 */
  maxLoaded?: number;
  /** 取当前时间（测试可注入确定性时钟）。 */
  now?: () => number;
}

/**
 * 本地推理后端：每个加载的 GGUF 起一个 llama.cpp `llama-server` 子进程（OpenAI 兼容），
 * 文本/视觉统一经此。取代 node-llama-cpp（参考 Unsloth）。
 */
export class LocalServerManager {
  private readonly handles = new Map<string, LocalHandle>();
  private readonly makeEngine: NonNullable<LocalServerManagerOptions["makeEngine"]>;
  private readonly binaryPath?: string;
  private readonly maxLoaded: number;
  private readonly now: () => number;

  constructor(
    private readonly registry: EngineRegistry,
    opts: LocalServerManagerOptions = {},
  ) {
    if (opts.binaryPath) this.binaryPath = opts.binaryPath;
    this.maxLoaded = Math.max(1, opts.maxLoaded ?? (Number(process.env.EW_MAX_LOADED_MODELS) || 3));
    this.now = opts.now ?? Date.now;
    this.makeEngine =
      opts.makeEngine ??
      ((id, o) =>
        new LlamaServerEngine({
          id,
          modelPath: o.modelPath,
          ...(o.mmprojPath ? { mmprojPath: o.mmprojPath } : {}),
          ...(o.contextSize ? { contextSize: o.contextSize } : {}),
          ...(typeof o.gpuLayers === "number" ? { gpuLayers: o.gpuLayers } : {}),
          ...(o.embeddingMode ? { embedding: true } : {}),
          port: o.port,
          ...(o.binaryPath ? { binaryPath: o.binaryPath } : {}),
        }));
  }

  /** 加载一个本地模型（起 llama-server 并注册路由）。id = modelPath。 */
  async load(opts: LocalLoadOptions): Promise<{ id: string; contextSize: number }> {
    const id = opts.modelPath;
    const existing = this.handles.get(id);
    if (existing) {
      existing.lastUsed = this.now();
      return { id, contextSize: existing.contextSize };
    }
    // 超出常驻上限 → 卸载最久未用的（LRU）。
    while (this.handles.size >= this.maxLoaded) {
      const lru = [...this.handles.values()].sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!lru) break;
      await this.unload(lru.id);
    }
    const port = await getFreePort();
    const engineId = `local:${path.basename(opts.modelPath)}`;
    const engine = this.makeEngine(engineId, {
      ...opts,
      port,
      ...(this.binaryPath ? { binaryPath: this.binaryPath } : {}),
    });
    await engine.start();
    // 注册"使用即触碰 lastUsed"的代理，让 LRU 反映真实使用而非加载顺序。
    const tracked = this.trackUsage(id, engine);
    this.registry.register(tracked);
    this.registry.routeModel(id, tracked);
    this.handles.set(id, {
      id,
      engine,
      contextSize: opts.contextSize ?? 0,
      lastUsed: this.now(),
      host: "127.0.0.1",
      port,
    });
    return { id, contextSize: opts.contextSize ?? 0 };
  }

  /** 已加载本地模型的 OpenAI 兼容 baseUrl（供 pi-ai openai-completions 驱动）。未加载返回 undefined。 */
  baseUrlFor(modelId: string): string | undefined {
    const h = this.handles.get(modelId);
    return h ? `http://${h.host}:${h.port}/v1` : undefined;
  }

  /** 包装引擎：调用 chat/chatStream/embed 时更新 lastUsed（供 LRU）。 */
  private trackUsage(id: string, engine: LocalEngineLike): LocalEngineLike {
    const touch = (): void => {
      const h = this.handles.get(id);
      if (h) h.lastUsed = this.now();
    };
    return new Proxy(engine, {
      get: (target, prop, recv) => {
        const v = Reflect.get(target, prop, recv) as unknown;
        if (prop === "chat" || prop === "chatStream" || prop === "embed") {
          return (...args: unknown[]) => {
            touch();
            return (v as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }) as LocalEngineLike;
  }

  /** 已加载模型的上下文长度映射（供 UI 显示上下文用量进度条）。 */
  contexts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const h of this.handles.values()) if (h.contextSize > 0) out[h.id] = h.contextSize;
    return out;
  }

  async unload(id: string): Promise<void> {
    const h = this.handles.get(id);
    if (!h) return;
    this.handles.delete(id);
    this.registry.unrouteModel(id);
    this.registry.unregister(h.engine.id);
    await h.engine.stop();
  }

  loadedIds(): string[] {
    return [...this.handles.keys()];
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.handles.values()].map((h) => h.engine.stop().catch(() => {})));
    this.handles.clear();
  }
}
