import fs from "node:fs";
import path from "node:path";
import type { DownloadEvent, GGUFVariant, HFModelSummary, LocalModel } from "@ew/shared";
import { HFClient } from "./hf.js";
import { downloadVariant, enumerateShards } from "./download.js";
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

  /**
   * 删除一个本地模型（id = gguf 全路径）：删主文件及其全部分片；
   * 若所在 repo 目录（modelsDir 下）已无其他 .gguf，则整目录删掉（连带共享的 mmproj）。
   * 路径硬校验必须落在 modelsDir / extraDirs 内，拒绝越界删除。
   */
  async deleteLocal(id: string): Promise<{ removed: string[] }> {
    const target = path.resolve(id);
    const managed = [this.modelsDir, ...this.extraDirs].map((d) => path.resolve(d));
    const under = managed.some((d) => target === d || target.startsWith(d + path.sep));
    if (!under) throw new Error("拒绝删除：模型不在受管目录内");
    if (!target.toLowerCase().endsWith(".gguf")) throw new Error("拒绝删除：不是 .gguf 文件");

    const dir = path.dirname(target);
    const base = path.basename(target);
    const shardMatch = /-(\d{5})-of-(\d{5})\.gguf$/i.exec(base);
    const files = shardMatch
      ? enumerateShards(base, Number(shardMatch[2])).map((n) => path.join(dir, n))
      : [target];

    const removed: string[] = [];
    for (const f of files) {
      try {
        await fs.promises.unlink(f);
        removed.push(f);
      } catch {
        /* 已不存在 / 无权限：跳过 */
      }
    }

    // 若该 repo 目录直属 modelsDir 且已无其它模型 gguf，整目录删掉（清理 mmproj 等残留）。
    const parentIsModelsRoot = path.resolve(path.dirname(dir)) === path.resolve(this.modelsDir);
    if (parentIsModelsRoot) {
      try {
        const rest = await fs.promises.readdir(dir);
        const hasModel = rest.some((n) => n.toLowerCase().endsWith(".gguf") && !/mmproj/i.test(n));
        if (!hasModel) await fs.promises.rm(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    return { removed };
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
        // router id = modelsDir 下的子目录名（llama serve --models-dir 的发现 id）；
        // 不在 modelsDir 下（extraDirs）则退化为父目录名（router 模式不服务这些，仅作展示）。
        const rel = path.relative(this.modelsDir, full);
        const routerId = rel && !rel.startsWith("..") ? rel.split(path.sep)[0]! : path.basename(path.dirname(full));
        found.push({
          id: full,
          routerId,
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
