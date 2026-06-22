import fs from "node:fs";
import path from "node:path";
import type { DownloadEvent, GGUFVariant, HFModelSummary, LocalModel } from "@ew/shared";
import { HFClient } from "./hf.js";
import { downloadVariant } from "./download.js";
import { readGGUFHeader } from "./gguf.js";

export interface ModelManagerOptions {
  modelsDir: string;
  extraDirs?: string[];
  hf?: HFClient;
  fetch?: typeof fetch;
}

/** 把 repoId 转成安全的本地目录名。 */
function safeRepoDir(repoId: string): string {
  return repoId.replace(/[^a-zA-Z0-9._-]+/g, "__");
}

const SHARD_NON_FIRST = /-(\d{5})-of-(\d{5})\.gguf$/i;

export class ModelManager {
  private readonly modelsDir: string;
  private readonly extraDirs: string[];
  private readonly hf: HFClient;

  constructor(opts: ModelManagerOptions) {
    this.modelsDir = opts.modelsDir;
    this.extraDirs = opts.extraDirs ?? [];
    this.hf = opts.hf ?? new HFClient({ fetch: opts.fetch });
  }

  search(query: string, opts?: { limit?: number; ggufOnly?: boolean }): Promise<HFModelSummary[]> {
    return this.hf.search(query, opts ?? {});
  }

  listVariants(repoId: string): Promise<GGUFVariant[]> {
    return this.hf.listVariants(repoId);
  }

  /** 下载一个变体到 modelsDir/<repo>/。 */
  download(
    variant: GGUFVariant,
    opts?: { hfToken?: string; signal?: AbortSignal },
  ): AsyncIterable<DownloadEvent> {
    const destDir = path.join(this.modelsDir, safeRepoDir(variant.repoId));
    return downloadVariant(variant, {
      destDir,
      resolveUrl: (fileName) => this.hf.resolveUrl(variant.repoId, fileName),
      token: opts?.hfToken,
      signal: opts?.signal,
    });
  }

  /** 扫描本地目录，返回已就绪模型（跳过非首分片、mmproj、.part）。 */
  async scanInventory(): Promise<LocalModel[]> {
    const dirs = [this.modelsDir, ...this.extraDirs];
    const found: LocalModel[] = [];
    const seen = new Set<string>();

    const walk = async (dir: string): Promise<void> => {
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          await walk(full);
          continue;
        }
        if (!e.name.toLowerCase().endsWith(".gguf")) continue;
        if (/mmproj/i.test(e.name)) continue;
        // 多分片只取第一片。
        const shard = SHARD_NON_FIRST.exec(e.name);
        if (shard && shard[1] !== "00001") continue;
        if (seen.has(full)) continue;
        seen.add(full);

        let size = 0;
        try {
          size = (await fs.promises.stat(full)).size;
        } catch {
          continue;
        }
        const header = await readGGUFHeader(full).catch(() => null);
        if (header && !header.isGGUF) continue;
        found.push({
          id: full,
          path: full,
          fileName: e.name,
          sizeBytes: size,
          contextDefault: header?.contextLength,
          arch: header?.arch,
          hasVision: header?.hasVision ?? false,
          source: "scanned",
          addedAt: new Date().toISOString(),
        });
      }
    };

    for (const d of dirs) await walk(d);
    return found;
  }
}
