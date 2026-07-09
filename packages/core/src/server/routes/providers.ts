import { getModels as getPiModels, getProviders as getPiProviders } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { CoreHttpContext } from "../context.js";

const ProviderModelConfigSchema = z.object({
  id: z.string().min(1),
  contextWindow: z.number().int().positive(),
  inputModalities: z.array(z.enum(["text", "image"])).min(1),
});

const ProviderConfigSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["openai-compatible", "pi-native"]).default("openai-compatible"),
  baseUrl: z.string().url().optional(),
  api: z.string().min(1).optional(),
  apiKey: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  modelConfigs: z.array(ProviderModelConfigSchema).min(1),
}).superRefine((cfg, ctx) => {
  if (cfg.kind === "openai-compatible" && !cfg.baseUrl) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["baseUrl"],
      message: "baseUrl is required for openai-compatible providers",
    });
  }
});

const ProviderModelProbeSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

function modelIdsFromResponse(payload: unknown): string[] {
  const data = (payload as { data?: unknown })?.data;
  const rawItems = Array.isArray(data) ? data : Array.isArray(payload) ? payload : [];
  const ids = rawItems
    .map((item) => (typeof item === "string" ? item : (item as { id?: unknown })?.id))
    .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    .map((id) => id.trim());
  return [...new Set(ids)];
}

async function fetchProviderModelIds(fetchImpl: typeof fetch, input: z.infer<typeof ProviderModelProbeSchema>): Promise<string[]> {
  const base = input.baseUrl.replace(/\/+$/, "");
  const urls = [new URL(`${base}/models`).toString()];
  if (!/\/v1$/i.test(base)) urls.push(new URL(`${base}/v1/models`).toString());
  let lastError = "";
  for (const url of [...new Set(urls)]) {
    try {
      const res = await fetchImpl(url, {
        headers: {
          accept: "application/json",
          ...(input.apiKey ? { authorization: `Bearer ${input.apiKey}` } : {}),
          ...(input.headers ?? {}),
        },
      });
      if (!res.ok) {
        lastError = `${res.status} ${res.statusText}`.trim();
        continue;
      }
      const ids = modelIdsFromResponse(await res.json());
      if (ids.length > 0) return ids;
      lastError = "empty model list";
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  throw new Error(lastError || "model list probe failed");
}

const PI_PROVIDER_LABELS: Record<string, string> = {
  "amazon-bedrock": "Amazon Bedrock",
  "ant-ling": "Ant Ling",
  anthropic: "Anthropic",
  "azure-openai-responses": "Azure OpenAI",
  cerebras: "Cerebras",
  "cloudflare-ai-gateway": "Cloudflare AI Gateway",
  "cloudflare-workers-ai": "Cloudflare Workers AI",
  deepseek: "DeepSeek",
  fireworks: "Fireworks",
  "github-copilot": "GitHub Copilot",
  google: "Google Gemini",
  "google-vertex": "Google Vertex AI",
  groq: "Groq",
  huggingface: "Hugging Face",
  "kimi-coding": "Kimi For Coding",
  minimax: "MiniMax",
  "minimax-cn": "MiniMax China",
  mistral: "Mistral",
  moonshotai: "Moonshot AI",
  "moonshotai-cn": "Moonshot AI China",
  nvidia: "NVIDIA NIM",
  opencode: "OpenCode Zen",
  "opencode-go": "OpenCode Go",
  openai: "OpenAI",
  "openai-codex": "OpenAI Codex",
  openrouter: "OpenRouter",
  together: "Together AI",
  "vercel-ai-gateway": "Vercel AI Gateway",
  xai: "xAI",
  xiaomi: "Xiaomi MiMo",
  "xiaomi-token-plan-ams": "Xiaomi MiMo Amsterdam",
  "xiaomi-token-plan-cn": "Xiaomi MiMo China",
  "xiaomi-token-plan-sgp": "Xiaomi MiMo Singapore",
  zai: "ZAI",
  "zai-coding-cn": "ZAI Coding Plan China",
};

const PI_PROVIDER_ORDER = [
  "openai",
  "anthropic",
  "google",
  "google-vertex",
  "mistral",
  "openrouter",
  "deepseek",
  "xai",
  "groq",
  "vercel-ai-gateway",
  "amazon-bedrock",
  "azure-openai-responses",
  "openai-codex",
  "github-copilot",
  "moonshotai",
  "zai",
  "minimax",
  "huggingface",
  "together",
  "fireworks",
  "cloudflare-ai-gateway",
  "cloudflare-workers-ai",
  "nvidia",
  "cerebras",
];

function titleFromId(id: string): string {
  return id
    .split("-")
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function piProviderCatalog(): {
  id: string;
  label: string;
  apiFamilies: string[];
  modelCount: number;
  sampleModels: string[];
  models: {
    id: string;
    name: string;
    api: string;
    contextWindow: number;
    inputModalities: ("text" | "image")[];
  }[];
}[] {
  const order = new Map(PI_PROVIDER_ORDER.map((id, index) => [id, index]));
  return getPiProviders()
    .map((id) => {
      const models = getPiModels(id);
      return {
        id,
        label: PI_PROVIDER_LABELS[id] ?? titleFromId(id),
        apiFamilies: [...new Set(models.map((m) => m.api))],
        modelCount: models.length,
        sampleModels: models.slice(0, 3).map((m) => m.id),
        models: models.map((m) => ({
          id: m.id,
          name: m.name,
          api: m.api,
          contextWindow: m.contextWindow,
          inputModalities: m.input,
        })),
      };
    })
    .sort((a, b) => {
      const ap = order.get(a.id) ?? Number.MAX_SAFE_INTEGER;
      const bp = order.get(b.id) ?? Number.MAX_SAFE_INTEGER;
      if (ap !== bp) return ap - bp;
      return a.label.localeCompare(b.label);
    });
}

export function registerProviderRoutes(ctx: CoreHttpContext): void {
  const { app, providers, sessionHost } = ctx;

  app.get("/providers", async () => ({ providers: providers.list() }));

  app.get("/providers/catalog", async () => ({ providers: piProviderCatalog() }));

  app.post("/providers/probe-models", async (req, reply) => {
    const parsed = ProviderModelProbeSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_provider_probe", detail: parsed.error.format() });
    }
    try {
      const models = await fetchProviderModelIds(ctx.fetchImpl, parsed.data);
      return { models };
    } catch (e) {
      return reply.code(502).send({
        error: "provider_probe_failed",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  });

  app.post("/providers", async (req, reply) => {
    const parsed = ProviderConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_provider", detail: parsed.error.format() });
    }
    providers.add(parsed.data);
    ctx.persistProviders();
    sessionHost.syncCloudProviders();
    return { ok: true };
  });

  app.delete("/providers/:id", async (req) => {
    providers.remove((req.params as { id: string }).id);
    ctx.persistProviders();
    sessionHost.syncCloudProviders();
    return { ok: true };
  });
}
