import { spawn, type ChildProcess } from "node:child_process";
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamEvent,
  EmbedRequest,
  EmbedResult,
  EngineCapabilities,
  InferenceEngine,
} from "@ew/shared";
import { OpenAICompatibleEngine } from "./openai-compatible.js";

export interface LlamaServerOptions {
  id?: string;
  /** llama-server 可执行文件路径（默认 PATH 中的 "llama-server"）。 */
  binaryPath?: string;
  /** 主模型 GGUF 路径。 */
  modelPath: string;
  /** 多模态投影器 mmproj GGUF（启用视觉）。 */
  mmprojPath?: string;
  port?: number;
  host?: string;
  contextSize?: number;
  gpuLayers?: number;
  /** embedding 模式：启动 --embedding 服务（用于本地记忆向量召回）。 */
  embedding?: boolean;
  /** llama-server --api-key：设置后所有请求（含本机回环）需 Bearer 鉴权。用于 0.0.0.0 暴露。 */
  apiKey?: string;
  /** 额外透传给 llama-server 的参数。 */
  extraArgs?: string[];
  /** 就绪探测超时（ms，默认 60s）。 */
  readyTimeoutMs?: number;
  fetch?: typeof fetch;
  /** 注入 spawn（测试用）。 */
  spawnFn?: typeof spawn;
}

/**
 * 多模态推理后端：以子进程方式运行 llama.cpp 的 `llama-server --mmproj`（OpenAI 兼容），
 * chat/embed 委托给指向该进程 /v1 的 OpenAICompatibleEngine。
 * node-llama-cpp 不支持视觉，故视觉走这里。多模态数据通路（image→image_url）已在内部引擎就绪。
 */
export class LlamaServerEngine implements InferenceEngine {
  readonly id: string;
  readonly capabilities: EngineCapabilities;
  private proc?: ChildProcess;
  private inner?: OpenAICompatibleEngine;
  private readonly opts: Required<Pick<LlamaServerOptions, "port" | "host">> & LlamaServerOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly spawnFn: typeof spawn;
  private readonly modelName = "local";

  constructor(opts: LlamaServerOptions) {
    this.id = opts.id ?? "llama-server";
    this.opts = { ...opts, port: opts.port ?? 8090, host: opts.host ?? "127.0.0.1" };
    this.fetchImpl = opts.fetch ?? fetch;
    this.spawnFn = opts.spawnFn ?? spawn;
    this.capabilities = {
      streaming: true,
      nativeToolCalls: true,
      vision: Boolean(opts.mmprojPath),
      audio: false,
      embeddings: true,
      jsonSchema: true,
    };
  }

  // 自连接恒走回环：--host 只控制对外绑定，daemon 与 llama-server 同机，自身调用用 127.0.0.1。
  private baseUrl(): string {
    return `http://127.0.0.1:${this.opts.port}/v1`;
  }

  private buildArgs(): string[] {
    const a = ["-m", this.opts.modelPath, "--host", this.opts.host, "--port", String(this.opts.port)];
    if (this.opts.embedding) {
      a.push("--embedding", "--pooling", "mean");
    } else {
      a.push("--jinja"); // 启用模型自带 chat template（含 tool/vision 模板）
    }
    if (this.opts.mmprojPath) a.push("--mmproj", this.opts.mmprojPath);
    if (this.opts.contextSize) a.push("-c", String(this.opts.contextSize));
    // 默认全量 GPU 卸载（Mac=Metal）；CPU-only 构建会自动忽略。
    a.push("-ngl", String(this.opts.gpuLayers ?? 999));
    if (this.opts.apiKey) a.push("--api-key", this.opts.apiKey);
    if (this.opts.extraArgs) a.push(...this.opts.extraArgs);
    return a;
  }

  /** 启动 llama-server 子进程并等待就绪。 */
  async start(): Promise<void> {
    if (this.proc) return;
    const bin = this.opts.binaryPath ?? "llama-server";
    // llama.app 的统一 `llama` 二进制经子命令 `llama serve` 起服务（flag 与 llama-server 一致）；
    // 经典 `llama-server` 直接调用。按文件名判断（兼容裸名 / 绝对路径 / .exe）。
    const unified = /(^|[\\/])llama(\.exe)?$/i.test(bin);
    const args = unified ? ["serve", ...this.buildArgs()] : this.buildArgs();
    this.proc = this.spawnFn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    this.proc.on("exit", () => {
      this.proc = undefined;
    });

    const deadline = Date.now() + (this.opts.readyTimeoutMs ?? 60_000);
    const healthUrl = `http://127.0.0.1:${this.opts.port}/health`;
    while (Date.now() < deadline) {
      try {
        const res = await this.fetchImpl(healthUrl);
        if (res.ok) {
          const j = (await res.json().catch(() => ({}))) as { status?: string };
          if (!j.status || j.status === "ok") break;
        }
      } catch {
        /* 还没起来 */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    this.inner = new OpenAICompatibleEngine({
      id: this.id,
      baseUrl: this.baseUrl(),
      capabilities: this.capabilities,
      fetch: this.fetchImpl,
      ...(this.opts.apiKey ? { apiKey: this.opts.apiKey } : {}),
    });
  }

  async stop(): Promise<void> {
    if (this.proc) {
      this.proc.kill("SIGTERM");
      this.proc = undefined;
    }
    this.inner = undefined;
  }

  private ensure(): OpenAICompatibleEngine {
    if (!this.inner) throw new Error("LlamaServerEngine 未启动（请先 start()）");
    return this.inner;
  }

  chat(req: ChatRequest): Promise<ChatResponse> {
    return this.ensure().chat({ ...req, model: this.modelName });
  }

  chatStream(req: ChatRequest): AsyncIterable<ChatStreamEvent> {
    return this.ensure().chatStream({ ...req, model: this.modelName });
  }

  embed(req: EmbedRequest): Promise<EmbedResult> {
    return this.ensure().embed({ ...req, model: this.modelName });
  }
}
