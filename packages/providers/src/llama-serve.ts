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

export interface LlamaServeOptions {
  id?: string;
  /** 统一 `llama`（llama.app）可执行文件路径（默认走 PATH 中的 "llama"）。 */
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
  /** --api-key：设置后所有请求（含本机回环）需 Bearer 鉴权。用于 0.0.0.0 暴露。 */
  apiKey?: string;
  /** 额外透传给 `llama serve` 的参数。 */
  extraArgs?: string[];
  /** 就绪探测超时（ms，默认 60s）。 */
  readyTimeoutMs?: number;
  fetch?: typeof fetch;
  /** 注入 spawn（测试用）。 */
  spawnFn?: typeof spawn;
}

/**
 * 单模型 `llama serve -m <gguf>` 子进程引擎（OpenAI 兼容）：chat/embed 委托给指向该进程 /v1
 * 的 OpenAICompatibleEngine。当前用于本地 embedding 服务（nomic-embed，语义召回）；亦支持
 * 多模态（`--mmproj`）。文本/视觉的常规推理走统一 router（见 RouterServerManager），不在此处。
 */
export class LlamaServeEngine implements InferenceEngine {
  readonly id: string;
  readonly capabilities: EngineCapabilities;
  private proc?: ChildProcess;
  private inner?: OpenAICompatibleEngine;
  private readonly opts: Required<Pick<LlamaServeOptions, "port" | "host">> & LlamaServeOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly spawnFn: typeof spawn;
  private readonly modelName = "local";

  constructor(opts: LlamaServeOptions) {
    this.id = opts.id ?? "llama-serve";
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

  // 自连接恒走回环：--host 只控制对外绑定，daemon 与 llama 子进程同机，自身调用用 127.0.0.1。
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

  /** 启动 `llama serve` 子进程并等待就绪。 */
  async start(): Promise<void> {
    if (this.proc) return;
    // 统一 `llama`（llama.app）二进制经子命令 `llama serve` 起服务。
    const bin = this.opts.binaryPath ?? "llama";
    this.proc = this.spawnFn(bin, ["serve", ...this.buildArgs()], { stdio: ["ignore", "pipe", "pipe"] });
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
    if (!this.inner) throw new Error("LlamaServeEngine 未启动（请先 start()）");
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
