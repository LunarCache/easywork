// 把 EasyWork 的 model id 解析为 pi-ai 的 Model（openai-completions），供 pi agentLoop/streamSimple 使用。
// 本地模型 → llama-server 的 OpenAI 兼容端点；云端模型 → provider 的 baseUrl + apiKey。
// pi-ai 的 streamSimple 按 model.api 选择 provider，按 model.baseUrl 自动探测兼容性。

/** pi-ai Model<"openai-completions"> 的最小子集（避免在此硬依赖 pi-ai 的类型）。 */
export interface PiOpenAICompatModel {
  id: string;
  name: string;
  api: "openai-completions";
  provider: string;
  baseUrl: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
}

export interface ResolvedPiModel {
  model: PiOpenAICompatModel;
  apiKey?: string;
}

export interface PiModelResolverDeps {
  /** 已加载本地模型 → OpenAI 兼容 baseUrl（如 LocalServerManager.baseUrlFor）。 */
  localBaseUrl(modelId: string): string | undefined;
  /** 云端模型 → provider 配置（如 ProviderManager.findByModel）。 */
  cloudProvider(modelId: string):
    | { id: string; baseUrl: string; apiKey?: string; headers?: Record<string, string> }
    | undefined;
  /** 模型的上下文窗口（可选，缺省 8192）。 */
  contextWindow?(modelId: string): number | undefined;
  /** 模型是否支持视觉（可选，缺省 false → input:["text"]）。 */
  vision?(modelId: string): boolean | undefined;
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function makeModel(opts: {
  id: string;
  baseUrl: string;
  provider: string;
  contextWindow: number;
  vision: boolean;
  headers?: Record<string, string>;
}): PiOpenAICompatModel {
  return {
    id: opts.id,
    name: opts.id.includes("/") || opts.id.includes("\\") ? opts.id.split(/[/\\]/).pop()! : opts.id,
    api: "openai-completions",
    provider: opts.provider,
    baseUrl: opts.baseUrl,
    reasoning: false,
    input: opts.vision ? ["text", "image"] : ["text"],
    cost: { ...ZERO_COST },
    contextWindow: opts.contextWindow,
    maxTokens: Math.min(4096, Math.floor(opts.contextWindow / 2)),
    ...(opts.headers ? { headers: opts.headers } : {}),
  };
}

/**
 * 解析 model id → pi-ai Model + apiKey。本地优先（已加载），否则云端 provider；都没有则抛错。
 */
export function resolvePiModel(modelId: string, deps: PiModelResolverDeps): ResolvedPiModel {
  const ctx = deps.contextWindow?.(modelId) || 8192;
  const vision = deps.vision?.(modelId) ?? false;

  const localUrl = deps.localBaseUrl(modelId);
  if (localUrl) {
    return {
      model: makeModel({ id: modelId, baseUrl: localUrl, provider: "local", contextWindow: ctx, vision }),
      apiKey: "local", // llama-server 忽略，避免 pi-ai 走 env key 查找
    };
  }

  const cloud = deps.cloudProvider(modelId);
  if (cloud) {
    return {
      model: makeModel({
        id: modelId,
        baseUrl: cloud.baseUrl.replace(/\/$/, ""),
        provider: cloud.id,
        contextWindow: ctx,
        vision,
        ...(cloud.headers ? { headers: cloud.headers } : {}),
      }),
      ...(cloud.apiKey ? { apiKey: cloud.apiKey } : {}),
    };
  }

  throw new Error(`无法解析模型为 pi-ai Model：${modelId}（既非已加载本地模型，也无云端 provider）`);
}
