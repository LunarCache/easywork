import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamEvent,
  EmbedRequest,
  EmbedResult,
  EngineCapabilities,
  InferenceEngine,
  LocalLoadOptions,
} from "@ew/shared";
import { OpenAICompatibleEngine } from "@ew/providers";
import type { EngineRegistry } from "./registry.js";
import { getFreePort, type LocalEndpoint } from "./net.js";
import type { LocalBackend } from "./local-backend.js";

/** 嵌入模型识别（与 UI modelKind 一致）：这些不进聊天路由（嵌入走独立 EmbeddingService 进程）。 */
const EMBED_RE = /embed|bert|bge|gte|e5|nomic|minilm/i;

const CHAT_CAPS: EngineCapabilities = {
  streaming: true,
  nativeToolCalls: true,
  vision: true,
  audio: false,
  embeddings: false,
  jsonSchema: true,
};

/** 路由到统一 router 的单模型包装引擎：强制把出站 `model` 固定为该 router id。 */
class RouterModelEngine implements InferenceEngine {
  readonly id: string;
  readonly capabilities = CHAT_CAPS;
  constructor(
    private readonly inner: OpenAICompatibleEngine,
    private readonly routerId: string,
  ) {
    this.id = `router:${routerId}`;
  }
  chat(req: ChatRequest): Promise<ChatResponse> {
    return this.inner.chat({ ...req, model: this.routerId });
  }
  chatStream(req: ChatRequest): AsyncIterable<ChatStreamEvent> {
    return this.inner.chatStream({ ...req, model: this.routerId });
  }
  embed(req: EmbedRequest): Promise<EmbedResult> {
    return this.inner.embed({ ...req, model: this.routerId });
  }
}

interface RouterModelInfo {
  id: string;
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
}

export interface RouterServerManagerOptions {
  /** 统一 `llama` 二进制路径（router 模式必需）。 */
  binaryPath?: string;
  /** `llama serve --models-dir <dir>`：模型目录（= modelsDir）。 */
  modelsDir: string;
  /** `--models-max`：同时常驻模型数上限（router 自身 LRU 淘汰）。默认 4。 */
  modelsMax?: number;
  /** 绑定 host：127.0.0.1（默认，仅本机）/ 0.0.0.0（局域网，强制 api-key）。 */
  bindHost?: string;
  /** `--api-key`（绑 0.0.0.0 暴露时必须）。 */
  apiKey?: string;
  /** 各 router id 的上下文窗口（读 GGUF 头），供 UI 进度环。 */
  contextsProvider?: () => Promise<Record<string, number>>;
  spawnFn?: typeof spawn;
  fetch?: typeof fetch;
  readyTimeoutMs?: number;
}

/**
 * 本地推理后端（router 模式）：起 1 个 `llama serve --models-dir` 路由进程，按请求 `model`（= 子目录名）
 * 路由、按需 auto-load、`--models-max` LRU 淘汰。取代每模型一进程的 LocalServerManager。
 * 嵌入模型不走此处（仍由 EmbeddingService 单独 `llama serve -m --embedding`）。
 */
export class RouterServerManager implements LocalBackend {
  private proc?: ChildProcess;
  private inner?: OpenAICompatibleEngine;
  private port = 0;
  private bindHost: string;
  private apiKey?: string;
  private binaryPath?: string;
  private readonly modelsDir: string;
  private readonly modelsMax: number;
  private readonly contextsProvider?: () => Promise<Record<string, number>>;
  private readonly spawnFn: typeof spawn;
  private readonly fetchImpl: typeof fetch;
  private readonly readyTimeoutMs: number;
  private readonly routes = new Map<string, RouterModelEngine>();
  private ctxCache: Record<string, number> = {};
  private opChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly registry: EngineRegistry,
    opts: RouterServerManagerOptions,
  ) {
    this.modelsDir = opts.modelsDir;
    this.modelsMax = Math.max(1, opts.modelsMax ?? (Number(process.env.EW_MAX_LOADED_MODELS) || 4));
    this.bindHost = opts.bindHost ?? "127.0.0.1";
    if (opts.binaryPath) this.binaryPath = opts.binaryPath;
    if (opts.apiKey) this.apiKey = opts.apiKey;
    if (opts.contextsProvider) this.contextsProvider = opts.contextsProvider;
    this.spawnFn = opts.spawnFn ?? spawn;
    this.fetchImpl = opts.fetch ?? fetch;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 60_000;
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.opChain.then(fn, fn);
    this.opChain = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  /** 自连接恒走回环（--host 只控制对外绑定，daemon 与 router 同机）。 */
  private loopback(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  private mgmtHeaders(): Record<string, string> {
    return this.apiKey ? { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" } : { "content-type": "application/json" };
  }

  /** modelPath（或带 .gguf 的路径）→ router id（modelsDir 下的子目录名）。 */
  private toRouterId(idOrPath: string): string {
    if (!(idOrPath.includes("/") || idOrPath.includes("\\") || idOrPath.endsWith(".gguf") || path.isAbsolute(idOrPath))) {
      return idOrPath; // 已是 router id
    }
    const rel = path.relative(this.modelsDir, idOrPath);
    return rel && !rel.startsWith("..") ? rel.split(path.sep)[0]! : path.basename(path.dirname(idOrPath));
  }

  /** 起 router 进程（若未起）并等就绪 + 同步路由。 */
  private async ensureRouter(): Promise<void> {
    if (this.proc) return;
    const bin = this.binaryPath;
    if (!bin) throw new Error("未解析到统一 `llama` 运行时（router 模式必需）。请经 llama.app 安装。");
    this.port = await getFreePort();
    const args = [
      "serve",
      "--models-dir",
      this.modelsDir,
      "--models-max",
      String(this.modelsMax),
      "--models-autoload",
      "--host",
      this.bindHost,
      "--port",
      String(this.port),
      ...(this.apiKey ? ["--api-key", this.apiKey] : []),
    ];
    this.proc = this.spawnFn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    this.proc.on("exit", () => {
      this.proc = undefined;
      this.inner = undefined;
    });

    const deadline = Date.now() + this.readyTimeoutMs;
    const healthUrl = `${this.loopback()}/health`;
    while (Date.now() < deadline) {
      try {
        const res = await this.fetchImpl(healthUrl, { headers: this.mgmtHeaders() });
        if (res.ok) break;
      } catch {
        /* 还没起来 */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    this.inner = new OpenAICompatibleEngine({
      id: "router",
      baseUrl: `${this.loopback()}/v1`,
      capabilities: CHAT_CAPS,
      fetch: this.fetchImpl,
      ...(this.apiKey ? { apiKey: this.apiKey } : {}),
    });
    await this.syncRoutes();
  }

  /** 拉 router 的 /v1/models，把（非嵌入）模型注册路由；消失的反注册。 */
  private async syncRoutes(): Promise<void> {
    if (!this.inner) return;
    let models: RouterModelInfo[] = [];
    try {
      const res = await this.fetchImpl(`${this.loopback()}/v1/models`, { headers: this.mgmtHeaders() });
      if (res.ok) {
        const json = (await res.json()) as { data?: RouterModelInfo[] };
        models = json.data ?? [];
      }
    } catch {
      /* 列举失败：保留现有路由 */
      return;
    }
    const ids = new Set(models.map((m) => m.id).filter((id) => !EMBED_RE.test(id)));
    // 新增
    for (const id of ids) {
      if (this.routes.has(id)) continue;
      const wrapper = new RouterModelEngine(this.inner, id);
      this.routes.set(id, wrapper);
      this.registry.register(wrapper);
      this.registry.routeModel(id, wrapper);
    }
    // 消失
    for (const id of [...this.routes.keys()]) {
      if (ids.has(id)) continue;
      const w = this.routes.get(id)!;
      this.routes.delete(id);
      this.registry.unrouteModel(id);
      this.registry.unregister(w.id);
    }
    if (this.contextsProvider) {
      try {
        this.ctxCache = await this.contextsProvider();
      } catch {
        /* ignore */
      }
    }
  }

  /** 管理 API（/v1/models/load|unload）；llama.cpp 不同版本路径前缀有别，先 /v1 再回退裸路径。 */
  private async mgmt(action: "load" | "unload", routerId: string): Promise<void> {
    const body = JSON.stringify({ model: routerId });
    for (const p of [`/v1/models/${action}`, `/models/${action}`]) {
      try {
        const res = await this.fetchImpl(`${this.loopback()}${p}`, { method: "POST", headers: this.mgmtHeaders(), body });
        if (res.ok) return;
        if (res.status !== 404) return; // 非 404 即该端点存在但失败（autoload 兜底），不再试另一路径
      } catch {
        /* 试下一路径 */
      }
    }
  }

  load(opts: LocalLoadOptions): Promise<{ id: string; contextSize: number }> {
    return this.serialize(async () => {
      const routerId = this.toRouterId(opts.modelPath);
      await this.ensureRouter();
      await this.mgmt("load", routerId); // 预热（autoload 下亦可省，但显式加载让首字更快）
      await this.syncRoutes();
      return { id: routerId, contextSize: this.ctxCache[routerId] ?? opts.contextSize ?? 0 };
    });
  }

  unload(id: string): Promise<void> {
    return this.serialize(async () => {
      const routerId = this.toRouterId(id);
      if (!this.proc) return;
      await this.mgmt("unload", routerId);
      const w = this.routes.get(routerId);
      if (w) {
        this.routes.delete(routerId);
        this.registry.unrouteModel(routerId);
        this.registry.unregister(w.id);
      }
    });
  }

  /** 已路由模型的内部 baseUrl（供 session-host 构 pi Model + /v1 本地透传）；非本地模型返回 undefined。 */
  baseUrlFor(modelId: string): string | undefined {
    const routerId = this.toRouterId(modelId);
    return this.proc && this.routes.has(routerId) ? `${this.loopback()}/v1` : undefined;
  }

  getBindHost(): string {
    return this.bindHost;
  }
  getApiKey(): string | undefined {
    return this.apiKey;
  }
  binaryPathOf(): string | undefined {
    return this.binaryPath;
  }
  setBinaryPath(p: string | undefined): void {
    this.binaryPath = p;
  }
  setBindHost(host: string): Promise<void> {
    return this.applyNet({ bindHost: host });
  }

  /** 切换绑定 host / api-key：重启单个 router 使其立即生效。 */
  applyNet(opts: { bindHost?: string; apiKey?: string | undefined }): Promise<void> {
    return this.serialize(async () => {
      const nextHost = opts.bindHost ?? this.bindHost;
      const nextKey = "apiKey" in opts ? opts.apiKey : this.apiKey;
      if (nextHost === this.bindHost && nextKey === this.apiKey) return;
      this.bindHost = nextHost;
      this.apiKey = nextKey || undefined;
      const wasRunning = !!this.proc;
      await this.stopUnlocked();
      if (wasRunning) await this.ensureRouter();
    });
  }

  endpoints(): LocalEndpoint[] {
    if (!this.proc) return [];
    return [{ id: "router", host: this.bindHost, port: this.port, baseUrl: `http://${this.bindHost}:${this.port}/v1` }];
  }

  contexts(): Record<string, number> {
    return this.ctxCache;
  }

  loadedIds(): string[] {
    return [...this.routes.keys()];
  }

  private async stopUnlocked(): Promise<void> {
    for (const [id, w] of this.routes) {
      this.registry.unrouteModel(id);
      this.registry.unregister(w.id);
    }
    this.routes.clear();
    this.inner = undefined;
    if (this.proc) {
      this.proc.kill("SIGTERM");
      this.proc = undefined;
    }
  }

  stopAll(): Promise<void> {
    return this.serialize(() => this.stopUnlocked());
  }
}
