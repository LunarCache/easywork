// @ew/sdk — daemon HTTP API 的类型化客户端。UI / IM 连接器 / 测试共用。
import type {
  AgentEvent,
  ChatMessage,
  ChatRequest,
  ChatStreamEvent,
  DownloadEvent,
  EngineCapabilities,
  GGUFVariant,
  HFModelSummary,
  LocalLoadOptions,
  LocalModel,
  McpServerConfig,
  SamplingParams,
  Skill,
} from "@ew/shared";

export interface ClientOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
}

export interface ModelsInfo {
  routed: string[];
  context?: Record<string, number>;
  engines: { id: string; capabilities: EngineCapabilities }[];
}

export interface ProviderInfo {
  id: string;
  baseUrl: string;
  models: string[];
}

export interface AddProviderConfig {
  id: string;
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  models: string[];
}

export class EasyWorkClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.token = opts.token;
    // 必须绑定到 globalThis：浏览器原生 fetch 作为对象方法调用会抛 "Illegal invocation"。
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return { authorization: `Bearer ${this.token}`, ...extra };
  }

  private async getJSON<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, { headers: this.headers() });
    if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
    return res.json() as Promise<T>;
  }

  private async postJSON<T>(path: string, body: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`POST ${path} failed: ${res.status} ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  /** 通用 SSE 流解析：逐帧产出 JSON，直到 [DONE]。 */
  private async *streamSSE<T>(
    path: string,
    body: unknown,
    init?: { signal?: AbortSignal },
  ): AsyncIterable<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify(body),
      signal: init?.signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`POST ${path} failed: ${res.status} ${await res.text().catch(() => "")}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const line = frame.replace(/^data:\s?/, "");
        if (line === "[DONE]") return;
        if (!line.trim()) continue;
        try {
          yield JSON.parse(line) as T;
        } catch {
          /* 忽略坏帧 */
        }
      }
    }
  }

  async health(): Promise<{ ok: boolean; name: string }> {
    const res = await this.fetchImpl(`${this.baseUrl}/health`);
    return res.json() as Promise<{ ok: boolean; name: string }>;
  }

  listModels(): Promise<ModelsInfo> {
    return this.getJSON<ModelsInfo>("/models");
  }

  loadModel(opts: LocalLoadOptions): Promise<{ id: string; contextSize: number }> {
    return this.postJSON("/models/load", opts);
  }

  async unloadModel(id: string): Promise<void> {
    await this.postJSON("/models/unload", { id });
  }

  async searchModels(query: string): Promise<HFModelSummary[]> {
    const { results } = await this.getJSON<{ results: HFModelSummary[] }>(
      `/models/search?q=${encodeURIComponent(query)}`,
    );
    return results;
  }

  async listVariants(repoId: string): Promise<GGUFVariant[]> {
    const { variants } = await this.getJSON<{ variants: GGUFVariant[] }>(
      `/models/variants?repoId=${encodeURIComponent(repoId)}`,
    );
    return variants;
  }

  async localModels(): Promise<LocalModel[]> {
    const { models } = await this.getJSON<{ models: LocalModel[] }>("/models/local");
    return models;
  }

  downloadModel(
    variant: GGUFVariant,
    opts?: { hfToken?: string; signal?: AbortSignal },
  ): AsyncIterable<DownloadEvent> {
    return this.streamSSE<DownloadEvent>(
      "/models/download",
      { variant, ...(opts?.hfToken ? { hfToken: opts.hfToken } : {}) },
      opts?.signal ? { signal: opts.signal } : undefined,
    );
  }

  async listProviders(): Promise<ProviderInfo[]> {
    const { providers } = await this.getJSON<{ providers: ProviderInfo[] }>("/providers");
    return providers;
  }

  async addProvider(cfg: AddProviderConfig): Promise<void> {
    await this.postJSON("/providers", cfg);
  }

  async removeProvider(id: string): Promise<void> {
    await this.fetchImpl(`${this.baseUrl}/providers/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: this.headers(),
    });
  }

  /** 内部流式对话（渠道无关 ChatStreamEvent）。 */
  chatStream(
    req: Omit<ChatRequest, "signal">,
    init?: { signal?: AbortSignal },
  ): AsyncIterable<ChatStreamEvent> {
    return this.streamSSE<ChatStreamEvent>("/chat/stream", req, init);
  }

  /** 运行 agent（工具/Skills/MCP 循环），流式发 AgentEvent。 */
  runAgent(
    input: {
      threadId?: string;
      model: string;
      history: ChatMessage[];
      maxIterations?: number;
      excludeTools?: string[];
      think?: boolean;
      sampling?: SamplingParams;
      kb?: boolean;
      kbId?: string;
    },
    init?: { signal?: AbortSignal },
  ): AsyncIterable<AgentEvent> {
    return this.streamSSE<AgentEvent>("/agent/run", input, init);
  }

  /** 回应工具审批请求（approval-request 事件携带 id）。 */
  async approveTool(id: string, verdict: "approve" | "approve-always" | "deny"): Promise<void> {
    await this.postJSON("/agent/approve", { id, verdict });
  }

  async listThreads(): Promise<{ id: string; title: string; updatedAt: string }[]> {
    const { threads } = await this.getJSON<{ threads: { id: string; title: string; updatedAt: string }[] }>(
      "/threads",
    );
    return threads;
  }

  async deleteThread(id: string): Promise<void> {
    await this.fetchImpl(`${this.baseUrl}/threads/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: this.headers(),
    });
  }

  async threadMessages(id: string): Promise<{ role: string; parts: { type: string; text?: string }[] }[]> {
    const { messages } = await this.getJSON<{
      messages: { role: string; parts: { type: string; text?: string }[] }[];
    }>(`/threads/${encodeURIComponent(id)}/messages`);
    return messages;
  }

  async listSkills(): Promise<Skill[]> {
    const { skills } = await this.getJSON<{ skills: Skill[] }>("/skills");
    return skills;
  }

  /** 列出技能并返回技能目录路径。 */
  async skillsInfo(): Promise<{ skills: Skill[]; dir: string }> {
    return this.getJSON<{ skills: Skill[]; dir: string }>("/skills");
  }

  /** 在系统文件管理器打开技能目录。 */
  async openSkillsDir(): Promise<{ ok: boolean; dir: string }> {
    return this.postJSON("/skills/open", {});
  }

  /** 在技能目录新建一个 SKILL.md 模板。 */
  async createSkillTemplate(name?: string): Promise<{ ok: boolean; file: string }> {
    return this.postJSON("/skills/template", name ? { name } : {});
  }

  async listMcpServers(): Promise<McpServerConfig[]> {
    const { servers } = await this.getJSON<{ servers: McpServerConfig[] }>("/mcp/servers");
    return servers;
  }

  async upsertMcpServer(config: McpServerConfig): Promise<void> {
    await this.postJSON("/mcp/servers", config);
  }

  async removeMcpServer(id: string): Promise<void> {
    await this.fetchImpl(`${this.baseUrl}/mcp/servers/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: this.headers(),
    });
  }

  async probeMcpServer(config: McpServerConfig): Promise<{ ok: boolean; toolCount: number; error?: string }> {
    return this.postJSON("/mcp/probe", config);
  }

  async editMemory(id: string, text: string): Promise<void> {
    await this.fetchImpl(`${this.baseUrl}/memory/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ text }),
    });
  }

  async deleteMemory(id: string): Promise<void> {
    await this.fetchImpl(`${this.baseUrl}/memory/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: this.headers(),
    });
  }

  /** 列出记忆条目（可按层过滤）。 */
  async listMemory(layer?: string): Promise<{ id: string; layer: string; text: string; sessionId?: string; updatedAt: string }[]> {
    const { items } = await this.getJSON<{
      items: { id: string; layer: string; text: string; sessionId?: string; updatedAt: string }[];
    }>(`/memory${layer ? `?layer=${encodeURIComponent(layer)}` : ""}`);
    return items;
  }

  // ---- 知识库 RAG ----
  async kbList(): Promise<{ kbs: { kbId: string; docs: number; chunks: number }[] }> {
    return this.getJSON("/kb/list");
  }

  async kbDocs(kbId?: string): Promise<{ docs: { id: string; kbId: string; source: string; chunks: number; createdAt: string }[]; chunks: number }> {
    return this.getJSON(`/kb/docs${kbId ? `?kbId=${encodeURIComponent(kbId)}` : ""}`);
  }

  async kbIngest(input: { source: string; text: string; kbId?: string }): Promise<{ doc: { id: string; source: string; chunks: number } }> {
    return this.postJSON("/kb/docs", input);
  }

  /** 上传本地文件内容（base64），后台异步解析+嵌入，返回 jobId。 */
  async kbUpload(input: { source: string; contentBase64: string; kbId?: string }): Promise<{ jobId: string }> {
    return this.postJSON("/kb/upload", input);
  }

  async kbJobs(): Promise<{
    jobs: {
      id: string;
      source: string;
      kbId: string;
      status: string;
      chunks?: number;
      done?: number;
      total?: number;
      error?: string;
    }[];
  }> {
    return this.getJSON("/kb/jobs");
  }

  async kbDeleteDoc(id: string): Promise<void> {
    await this.fetchImpl(`${this.baseUrl}/kb/docs/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: this.headers(),
    });
  }

  async kbSearch(query: string, topK?: number): Promise<{ hits: { text: string; source: string; score: number }[] }> {
    const qs = new URLSearchParams({ q: query, ...(topK ? { topK: String(topK) } : {}) });
    return this.getJSON(`/kb/search?${qs}`);
  }

  /** 召回记忆（带相关度分数，调试/检视用）。 */
  async recallMemory(query: string, topK?: number): Promise<{ text: string; score?: number; layer: string }[]> {
    const qs = new URLSearchParams({ q: query, ...(topK ? { topK: String(topK) } : {}) });
    const { hits } = await this.getJSON<{ hits: { text: string; score?: number; layer: string }[] }>(
      `/memory/recall?${qs}`,
    );
    return hits;
  }

  /** 记忆向量召回的 embedding 模型状态。 */
  embeddingStatus(): Promise<{ ready: boolean; modelId?: string; dim: number }> {
    return this.getJSON("/memory/embedding");
  }

  /** 启用/切换本地 CPU embedding 模型（默认 nomic-embed-text）。下载+加载+重建索引，可能耗时。 */
  enableEmbedding(
    opts: { repoId?: string; fileName?: string; modelPath?: string } = {},
  ): Promise<{ ready: boolean; modelId?: string; dim: number; reindexed: number }> {
    return this.postJSON("/memory/embedding", opts);
  }
}

export type { ChatRequest, ChatStreamEvent } from "@ew/shared";
