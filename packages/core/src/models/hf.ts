import type { GGUFVariant, HFModelSummary } from "@ew/shared";

const HF_BASE = "https://huggingface.co";

export interface HFFile {
  path: string;
  size: number;
}

const SHARD_RE = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i;
const QUANT_RE = /(IQ\d[_A-Z0-9]*|Q\d[_A-Z0-9]*|BF16|F16|F32)/i;

function extractQuant(fileName: string): string {
  const m = QUANT_RE.exec(fileName);
  return m ? m[1]!.toUpperCase() : "unknown";
}

/**
 * 把仓库文件列表归组为逻辑 GGUF 变体（纯函数，可单测）。
 * - 多分片 `*-00001-of-00003.gguf` 归为一个 variant（shardCount=总数，fileName=第一分片）。
 * - mmproj 文件不作为独立变体，作为 vision 投影附加。
 */
export function groupVariants(repoId: string, files: HFFile[]): GGUFVariant[] {
  const gguf = files.filter((f) => f.path.toLowerCase().endsWith(".gguf"));
  const mmproj = gguf.find((f) => /mmproj/i.test(f.path));
  const modelFiles = gguf.filter((f) => !/mmproj/i.test(f.path));

  const groups = new Map<string, { firstShard: string; totalSize: number; shardCount: number }>();
  for (const f of modelFiles) {
    const base = f.path.split("/").pop() ?? f.path;
    const shard = SHARD_RE.exec(base);
    if (shard) {
      const key = `${shard[1]}-of-${shard[3]}`;
      const total = Number(shard[3]);
      const idx = Number(shard[2]);
      const g = groups.get(key) ?? { firstShard: base, totalSize: 0, shardCount: total };
      g.totalSize += f.size;
      if (idx === 1) g.firstShard = base;
      groups.set(key, g);
    } else {
      groups.set(base, { firstShard: base, totalSize: f.size, shardCount: 1 });
    }
  }

  const variants: GGUFVariant[] = [];
  for (const g of groups.values()) {
    variants.push({
      repoId,
      fileName: g.firstShard,
      quant: extractQuant(g.firstShard),
      sizeBytes: g.totalSize,
      shardCount: g.shardCount,
      ...(mmproj ? { mmprojFile: mmproj.path.split("/").pop() } : {}),
    });
  }
  variants.sort((a, b) => a.sizeBytes - b.sizeBytes);
  return variants;
}

export interface HFClientOptions {
  token?: string;
  fetch?: typeof fetch;
}

export class HFClient {
  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HFClientOptions = {}) {
    this.token = opts.token;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  private headers(): Record<string, string> {
    return this.token ? { authorization: `Bearer ${this.token}` } : {};
  }

  /** 搜索模型（默认过滤 GGUF）。 */
  async search(query: string, opts: { limit?: number; ggufOnly?: boolean } = {}): Promise<HFModelSummary[]> {
    const params = new URLSearchParams({
      search: query,
      limit: String(opts.limit ?? 20),
      sort: "downloads",
      direction: "-1",
    });
    if (opts.ggufOnly !== false) params.set("filter", "gguf");
    const res = await this.fetchImpl(`${HF_BASE}/api/models?${params}`, { headers: this.headers() });
    if (!res.ok) throw new Error(`HF search failed: ${res.status}`);
    const list = (await res.json()) as any[];
    return list.map((m) => ({
      repoId: m.id ?? m.modelId,
      author: m.author ?? (m.id ?? "").split("/")[0] ?? "",
      downloads: m.downloads ?? 0,
      likes: m.likes ?? 0,
      tags: m.tags ?? [],
      hasGGUF: (m.tags ?? []).includes("gguf"),
      updatedAt: m.lastModified ?? m.createdAt ?? "",
    }));
  }

  /** 列出仓库文件树（含大小）。 */
  async listFiles(repoId: string, revision = "main"): Promise<HFFile[]> {
    const res = await this.fetchImpl(
      `${HF_BASE}/api/models/${repoId}/tree/${revision}?recursive=true`,
      { headers: this.headers() },
    );
    if (!res.ok) throw new Error(`HF tree failed: ${res.status}`);
    const list = (await res.json()) as any[];
    return list
      .filter((e) => e.type === "file")
      .map((e) => ({ path: e.path as string, size: (e.size as number) ?? 0 }));
  }

  /** 列出仓库内的逻辑 GGUF 变体。 */
  async listVariants(repoId: string): Promise<GGUFVariant[]> {
    const files = await this.listFiles(repoId);
    return groupVariants(repoId, files);
  }

  /** 构造文件下载 URL。 */
  resolveUrl(repoId: string, fileName: string, revision = "main"): string {
    return `${HF_BASE}/${repoId}/resolve/${revision}/${fileName}`;
  }
}
