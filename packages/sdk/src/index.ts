// @ew/sdk — daemon HTTP API 的类型化客户端。UI / IM 连接器 / 测试共用。
import type {
  AgentEvent,
  ApprovalMode,
  ChatMessage,
  DownloadEvent,
  EngineCapabilities,
  GGUFVariant,
  HFModelSummary,
  LocalLoadOptions,
  LocalModel,
  McpServerConfig,
  Project,
  SamplingParams,
  Skill,
} from "@ew/shared";

export type { Project, ApprovalMode } from "@ew/shared";

/** 工作区文件树条目。 */
export interface WsEntry {
  path: string;
  type: "file" | "dir";
  size?: number;
}

/** git 改动文件。 */
export interface GitFile {
  path: string;
  index: string;
  work: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  adds: number;
  dels: number;
}
export interface GitStatus {
  repo: boolean;
  branch?: string;
  files: GitFile[];
}
export interface GitCommit {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  relDate: string;
}
export interface GitRemoteInfo {
  hasRemote: boolean;
  hasUpstream: boolean;
  ahead: number;
  behind: number;
  upstream?: string;
}

export interface ClientOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
}

export interface LocalEndpoint {
  id: string;
  host: string;
  port: number;
  baseUrl: string;
}

export interface ModelsInfo {
  routed: string[];
  context?: Record<string, number>;
  engines: { id: string; capabilities: EngineCapabilities }[];
  /** 本地 llama-server 对外端点（发现/外部直连）。 */
  endpoints?: LocalEndpoint[];
  /** 当前 llama-server 绑定 host。 */
  bindHost?: string;
}

export interface LocalNetInfo {
  bindHost: string;
  /** llama-server --api-key（绑 0.0.0.0 时必有）；未设为 null。 */
  apiKey?: string | null;
  lanIp?: string;
  endpoints: LocalEndpoint[];
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

  /** 本地 llama-server 网络暴露：当前绑定 host + 局域网 IP + 各模型端点。 */
  getLocalNet(): Promise<LocalNetInfo> {
    return this.getJSON<LocalNetInfo>("/settings/local-net");
  }

  /** 切换本地 llama-server 绑定 host（0.0.0.0 必须带 apiKey）。重载已加载模型生效。 */
  setLocalNet(bindHost: "127.0.0.1" | "0.0.0.0", apiKey?: string): Promise<LocalNetInfo & { ok: boolean }> {
    return this.postJSON<LocalNetInfo & { ok: boolean }>("/settings/local-net", {
      bindHost,
      ...(apiKey !== undefined ? { apiKey } : {}),
    });
  }

  /** 运行 agent（pi 托管会话），流式发 AgentEvent。 */
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
      projectId?: string;
    },
    init?: { signal?: AbortSignal },
  ): AsyncIterable<AgentEvent> {
    return this.streamSSE<AgentEvent>("/agent/run", input, init);
  }

  // ---- 工作区项目 ----
  async listProjects(): Promise<Project[]> {
    return (await this.getJSON<{ projects: Project[] }>("/projects")).projects;
  }

  async createProject(p: {
    name?: string;
    workspaceDir?: string;
    approvalMode?: ApprovalMode;
    instructions?: string;
  }): Promise<Project> {
    return this.postJSON<Project>("/projects", p);
  }

  async updateProject(
    id: string,
    patch: { name?: string; workspaceDir?: string; approvalMode?: ApprovalMode; instructions?: string },
  ): Promise<Project> {
    const res = await this.fetchImpl(`${this.baseUrl}/projects/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(`PATCH /projects failed: ${res.status}`);
    return res.json() as Promise<Project>;
  }

  async deleteProject(id: string): Promise<void> {
    await this.fetchImpl(`${this.baseUrl}/projects/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: this.headers(),
    });
  }

  /** 列出工作区项目内某目录（文件树）。 */
  async wsList(projectId: string, path = ".", depth = 1): Promise<WsEntry[]> {
    const q = new URLSearchParams({ path, depth: String(depth) });
    return (
      await this.getJSON<{ entries: WsEntry[] }>(`/workspace/${encodeURIComponent(projectId)}/fs/list?${q}`)
    ).entries;
  }

  /** 读取工作区项目内某文件（只读查看）。 */
  async wsRead(
    projectId: string,
    path: string,
    range?: { start?: number; end?: number },
  ): Promise<{ content?: string; binary?: boolean; truncated?: boolean; size: number }> {
    const q = new URLSearchParams({ path });
    if (range?.start) q.set("start", String(range.start));
    if (range?.end) q.set("end", String(range.end));
    return this.getJSON(`/workspace/${encodeURIComponent(projectId)}/fs/read?${q}`);
  }

  /** 列出对话会话产出的工件文件（每会话目录 <workspace>/chats/<threadId>）。 */
  async chatFiles(threadId: string, path = ".", depth = 4): Promise<WsEntry[]> {
    const q = new URLSearchParams({ path, depth: String(depth) });
    return (
      await this.getJSON<{ entries: WsEntry[] }>(`/chat/${encodeURIComponent(threadId)}/files?${q}`)
    ).entries;
  }

  /** 读取对话会话工件文件（只读预览）。 */
  async chatFile(
    threadId: string,
    path: string,
    range?: { start?: number; end?: number },
  ): Promise<{ content?: string; binary?: boolean; truncated?: boolean; size: number }> {
    const q = new URLSearchParams({ path });
    if (range?.start) q.set("start", String(range.start));
    if (range?.end) q.set("end", String(range.end));
    return this.getJSON(`/chat/${encodeURIComponent(threadId)}/file?${q}`);
  }

  // ---- 工作区 git ----
  private wsGit(projectId: string): string {
    return `/workspace/${encodeURIComponent(projectId)}/git`;
  }
  async gitStatus(projectId: string): Promise<GitStatus> {
    return this.getJSON(`${this.wsGit(projectId)}/status`);
  }
  async gitDiff(projectId: string, path: string, staged = false): Promise<string> {
    const q = new URLSearchParams({ path, ...(staged ? { staged: "1" } : {}) });
    return (await this.getJSON<{ diff: string }>(`${this.wsGit(projectId)}/diff?${q}`)).diff;
  }
  async gitBranches(projectId: string): Promise<{ current: string; all: string[] }> {
    return this.getJSON(`${this.wsGit(projectId)}/branches`);
  }
  async gitStage(projectId: string, paths?: string[]): Promise<{ ok: boolean; error?: string }> {
    return this.postJSON(`${this.wsGit(projectId)}/stage`, paths ? { paths } : { all: true });
  }
  async gitUnstage(projectId: string, paths?: string[]): Promise<{ ok: boolean; error?: string }> {
    return this.postJSON(`${this.wsGit(projectId)}/unstage`, paths ? { paths } : { all: true });
  }
  async gitRevert(projectId: string, paths?: string[]): Promise<{ ok: boolean }> {
    return this.postJSON(`${this.wsGit(projectId)}/revert`, paths ? { paths } : { all: true });
  }
  async gitCommit(projectId: string, message: string): Promise<{ ok: boolean; error?: string }> {
    return this.postJSON(`${this.wsGit(projectId)}/commit`, { message });
  }
  async gitSwitch(projectId: string, name: string): Promise<{ ok: boolean; error?: string }> {
    return this.postJSON(`${this.wsGit(projectId)}/switch`, { name });
  }
  async gitLog(projectId: string, limit = 30): Promise<GitCommit[]> {
    return (await this.getJSON<{ commits: GitCommit[] }>(`${this.wsGit(projectId)}/log?limit=${limit}`)).commits;
  }
  async gitRemote(projectId: string): Promise<GitRemoteInfo> {
    return this.getJSON(`${this.wsGit(projectId)}/remote`);
  }
  async gitPush(projectId: string): Promise<{ ok: boolean; message: string }> {
    return this.postJSON(`${this.wsGit(projectId)}/push`, {});
  }
  async gitPull(projectId: string): Promise<{ ok: boolean; message: string }> {
    return this.postJSON(`${this.wsGit(projectId)}/pull`, {});
  }
  /** 单个改动块的接受/拒绝：stage（暂存块）/ unstage（取消暂存块）/ discard（丢弃块）。 */
  async gitHunk(
    projectId: string,
    path: string,
    hunkIndex: number,
    op: "stage" | "unstage" | "discard",
  ): Promise<{ ok: boolean; error?: string }> {
    return this.postJSON(`${this.wsGit(projectId)}/hunk`, { path, hunkIndex, op });
  }

  /** 回应工具审批请求（approval-request 事件携带 id）。 */
  async approveTool(id: string, verdict: "approve" | "approve-always" | "deny"): Promise<void> {
    await this.postJSON("/agent/approve", { id, verdict });
  }

  async listThreads(
    filter?: { projectId?: string },
  ): Promise<{ id: string; title: string; updatedAt: string; projectId?: string }[]> {
    const qs = filter?.projectId ? `?projectId=${encodeURIComponent(filter.projectId)}` : "";
    const { threads } = await this.getJSON<{
      threads: { id: string; title: string; updatedAt: string; projectId?: string }[];
    }>(`/threads${qs}`);
    return threads;
  }

  async deleteThread(id: string): Promise<void> {
    await this.fetchImpl(`${this.baseUrl}/threads/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: this.headers(),
    });
  }

  async threadMessages(id: string): Promise<
    {
      role: string;
      parts: { type: string; text?: string; mimeType?: string; data?: string }[];
      toolCalls?: { id: string; name: string; arguments: string }[];
      toolResults?: { content: unknown; isError?: boolean; display?: unknown }[];
    }[]
  > {
    const { messages } = await this.getJSON<{
      messages: {
        role: string;
        parts: { type: string; text?: string; mimeType?: string; data?: string }[];
        toolCalls?: { id: string; name: string; arguments: string }[];
        toolResults?: { content: unknown; isError?: boolean; display?: unknown }[];
      }[];
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

  /** 清空某作用域的全部记忆（如某工作区私有池）。返回删除条数。 */
  async clearMemoryScope(scope: string): Promise<{ removed: number }> {
    const res = await this.fetchImpl(`${this.baseUrl}/memory/scope/${encodeURIComponent(scope)}`, {
      method: "DELETE",
      headers: this.headers(),
    });
    return (await res.json()) as { removed: number };
  }

  /** 列出记忆条目（可按作用域/层过滤）。 */
  async listMemory(
    opts: { scope?: string; layer?: string } = {},
  ): Promise<{ id: string; scope?: string; layer: string; text: string; sessionId?: string; updatedAt: string }[]> {
    const qs = new URLSearchParams();
    if (opts.scope) qs.set("scope", opts.scope);
    if (opts.layer) qs.set("layer", opts.layer);
    const q = qs.toString();
    const { items } = await this.getJSON<{
      items: { id: string; scope?: string; layer: string; text: string; sessionId?: string; updatedAt: string }[];
    }>(`/memory${q ? `?${q}` : ""}`);
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

  /** 召回记忆（带相关度分数，调试/检视用；可限定作用域）。 */
  async recallMemory(
    query: string,
    topK?: number,
    scope?: string,
  ): Promise<{ text: string; score?: number; layer: string; scope?: string }[]> {
    const qs = new URLSearchParams({ q: query, ...(topK ? { topK: String(topK) } : {}), ...(scope ? { scope } : {}) });
    const { hits } = await this.getJSON<{ hits: { text: string; score?: number; layer: string; scope?: string }[] }>(
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
