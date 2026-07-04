import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ChatStreamEvent,
  EmbedRequest,
  EmbedResult,
  EngineCapabilities,
  FinishReason,
  InferenceEngine,
  ToolCall,
  Usage,
} from "@ew/shared";
import { parseSSE } from "./sse.js";
import { toOpenAIMessages, toOpenAITools } from "./openai-messages.js";
import { HarmonyParser } from "./harmony.js";

export interface OpenAICompatibleConfig {
  /** 引擎唯一 id，如 "openai" / "openrouter" / "vllm-local"。 */
  id: string;
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  capabilities?: Partial<EngineCapabilities>;
  fetch?: typeof fetch;
}

const DEFAULT_CAPS: EngineCapabilities = {
  streaming: true,
  nativeToolCalls: true,
  vision: true,
  audio: false,
  embeddings: true,
  jsonSchema: true,
};

function mapFinishReason(r: string | null | undefined): FinishReason {
  switch (r) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    case "content_filter":
      return "content_filter";
    default:
      return "stop";
  }
}

interface ToolAccum {
  id: string;
  name: string;
  args: string;
  started: boolean;
}

interface OpenAIUsageShape {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface OpenAIToolCallShape {
  id?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface OpenAIChatCompletionShape {
  model?: string;
  usage?: OpenAIUsageShape;
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      tool_calls?: OpenAIToolCallShape[];
    };
  }>;
}

interface OpenAIStreamToolCallShape extends OpenAIToolCallShape {
  index?: number;
}

interface OpenAIStreamChunkShape {
  usage?: OpenAIUsageShape;
  choices?: Array<{
    finish_reason?: string | null;
    delta?: {
      content?: string;
      reasoning_content?: string;
      tool_calls?: OpenAIStreamToolCallShape[];
    };
  }>;
}

interface OpenAIEmbeddingShape {
  model?: string;
  data?: Array<{ embedding?: number[] }>;
}

/** 通用 OpenAI 兼容引擎。覆盖 OpenAI / vLLM / OpenRouter / 各家兼容 API。 */
export class OpenAICompatibleEngine implements InferenceEngine {
  readonly id: string;
  readonly capabilities: EngineCapabilities;
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: OpenAICompatibleConfig) {
    this.id = cfg.id;
    this.baseUrl = cfg.baseUrl.replace(/\/$/, "");
    this.apiKey = cfg.apiKey;
    this.extraHeaders = cfg.headers ?? {};
    this.capabilities = { ...DEFAULT_CAPS, ...cfg.capabilities };
    this.fetchImpl = cfg.fetch ?? fetch;
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      ...this.extraHeaders,
    };
  }

  private buildBody(req: ChatRequest, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: toOpenAIMessages(req.messages),
      stream,
    };
    const tools = toOpenAITools(req.tools);
    if (tools) body.tools = tools;
    if (req.toolChoice) {
      body.tool_choice =
        typeof req.toolChoice === "object"
          ? { type: "function", function: { name: req.toolChoice.name } }
          : req.toolChoice;
    }
    if (req.temperature != null) body.temperature = req.temperature;
    if (req.topP != null) body.top_p = req.topP;
    if (req.maxTokens != null) body.max_tokens = req.maxTokens;
    if (req.stop) body.stop = req.stop;
    if (req.seed != null) body.seed = req.seed;
    // 标准 OpenAI 字段
    if (req.frequencyPenalty != null) body.frequency_penalty = req.frequencyPenalty;
    if (req.presencePenalty != null) body.presence_penalty = req.presencePenalty;
    // llama.cpp / vLLM 扩展采样字段（OpenAI 官方无，但 llama.cpp 接受）
    if (req.topK != null) body.top_k = req.topK;
    if (req.minP != null) body.min_p = req.minP;
    if (req.repeatPenalty != null) body.repeat_penalty = req.repeatPenalty;
    // 思维努力（gpt-oss / 兼容模板）
    if (req.reasoningEffort != null) body.reasoning_effort = req.reasoningEffort;
    if (req.responseFormat) {
      body.response_format =
        req.responseFormat.type === "json_schema"
          ? { type: "json_schema", json_schema: { schema: req.responseFormat.schema, name: "response" } }
          : { type: req.responseFormat.type };
    }
    if (stream) body.stream_options = { include_usage: true };
    return body;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(this.buildBody(req, false)),
      signal: req.signal,
    });
    if (!res.ok) throw new Error(`${this.id} chat failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as OpenAIChatCompletionShape;
    const choice = json.choices?.[0];
    const msg = choice?.message ?? {};
    const toolCalls: ToolCall[] | undefined = msg.tool_calls?.map((tc) => ({
      id: tc.id ?? "",
      name: tc.function?.name ?? "",
      arguments: tc.function?.arguments ?? "",
    }));
    const message: ChatMessage = {
      role: "assistant",
      content: msg.content ?? "",
      ...(toolCalls?.length ? { toolCalls } : {}),
    };
    return {
      message,
      finishReason: mapFinishReason(choice?.finish_reason),
      usage: json.usage
        ? {
            promptTokens: json.usage.prompt_tokens ?? 0,
            completionTokens: json.usage.completion_tokens ?? 0,
            totalTokens: json.usage.total_tokens ?? 0,
          }
        : undefined,
      model: json.model ?? req.model,
    };
  }

  async *chatStream(req: ChatRequest): AsyncIterable<ChatStreamEvent> {
    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(this.buildBody(req, true)),
      signal: req.signal,
    });
    if (!res.ok || !res.body) {
      yield {
        type: "error",
        message: `${this.id} stream failed: ${res.status} ${await res.text().catch(() => "")}`,
      };
      return;
    }

    let text = "";
    const tools = new Map<number, ToolAccum>();
    let finishReason: FinishReason = "stop";
    let usage: Usage | undefined;
    const harmony = new HarmonyParser();

    for await (const chunk of parseSSE(res.body)) {
      const c = chunk as OpenAIStreamChunkShape;
      if (c.usage) {
        usage = {
          promptTokens: c.usage.prompt_tokens ?? 0,
          completionTokens: c.usage.completion_tokens ?? 0,
          totalTokens: c.usage.total_tokens ?? 0,
        };
        yield { type: "usage", usage };
      }
      const choice = c.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};

      if (typeof delta.content === "string" && delta.content.length > 0) {
        // harmony 兜底：原始 <|channel|> token 落在 content 时，把 analysis 归为 reasoning、final 归为 text。
        const seg = harmony.push(delta.content);
        if (seg.reasoning) yield { type: "reasoning-delta", text: seg.reasoning };
        if (seg.text) {
          text += seg.text;
          yield { type: "text-delta", text: seg.text };
        }
      }
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
        yield { type: "reasoning-delta", text: delta.reasoning_content };
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx: number = tc.index ?? 0;
          let acc = tools.get(idx);
          if (!acc) {
            acc = { id: tc.id ?? `call_${idx}`, name: "", args: "", started: false };
            tools.set(idx, acc);
          }
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name += tc.function.name;
          if (!acc.started && acc.name) {
            acc.started = true;
            yield { type: "tool-call-start", index: idx, id: acc.id, name: acc.name };
          }
          if (tc.function?.arguments) {
            acc.args += tc.function.arguments;
            yield { type: "tool-call-args-delta", index: idx, delta: tc.function.arguments };
          }
        }
      }

      if (choice.finish_reason) finishReason = mapFinishReason(choice.finish_reason);
    }

    // 流末 flush harmony 残留缓冲。
    const tail = harmony.flush();
    if (tail.reasoning) yield { type: "reasoning-delta", text: tail.reasoning };
    if (tail.text) {
      text += tail.text;
      yield { type: "text-delta", text: tail.text };
    }

    const toolCalls: ToolCall[] = [];
    for (const [idx, acc] of [...tools.entries()].sort((a, b) => a[0] - b[0])) {
      if (acc.started) yield { type: "tool-call-end", index: idx };
      toolCalls.push({ id: acc.id, name: acc.name, arguments: acc.args });
    }
    if (toolCalls.length > 0) finishReason = "tool_calls";

    const message: ChatMessage = {
      role: "assistant",
      content: text,
      ...(toolCalls.length ? { toolCalls } : {}),
    };
    yield { type: "done", finishReason, message };
  }

  async embed(req: EmbedRequest): Promise<EmbedResult> {
    const res = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ model: req.model, input: req.input }),
    });
    if (!res.ok) throw new Error(`${this.id} embed failed: ${res.status}`);
    const json = (await res.json()) as OpenAIEmbeddingShape;
    const vectors: number[][] = (json.data ?? []).map((d) => d.embedding ?? []);
    return { vectors, model: json.model ?? req.model };
  }
}
