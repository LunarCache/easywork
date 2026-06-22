import fs from "node:fs";
import path from "node:path";
import type { DownloadEvent, GGUFVariant, LocalModel } from "@ew/shared";
import { readGGUFHeader } from "./gguf.js";

const SHARD_RE = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i;

/** 由第一分片文件名 + 分片数枚举出全部分片文件名。 */
export function enumerateShards(fileName: string, shardCount: number): string[] {
  if (shardCount <= 1) return [fileName];
  const m = SHARD_RE.exec(fileName);
  if (!m) return [fileName];
  const prefix = m[1]!;
  const total = m[3]!;
  const names: string[] = [];
  for (let i = 1; i <= shardCount; i++) {
    names.push(`${prefix}-${String(i).padStart(5, "0")}-of-${total}.gguf`);
  }
  return names;
}

export interface DownloadOptions {
  resolveUrl: (fileName: string) => string;
  destDir: string;
  token?: string;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  /** 单分片短读后的重试次数（默认 4）。 */
  maxRetries?: number;
}

/**
 * 下载一个逻辑变体（含全部分片），带 Range 续传、进度事件、**大小校验 + 短读自动重试**。
 * 关键正确性：短读（流被提前关闭）不会把残缺文件 rename 成最终文件 —— 保留 .part 以便续传。
 */
export async function* downloadVariant(
  variant: GGUFVariant,
  opts: DownloadOptions,
): AsyncIterable<DownloadEvent> {
  const fetchImpl = opts.fetch ?? fetch;
  const maxRetries = opts.maxRetries ?? 4;
  yield { type: "queued" };

  fs.mkdirSync(opts.destDir, { recursive: true });
  const shards = enumerateShards(variant.fileName, variant.shardCount);
  const totalBytes = variant.sizeBytes;
  // 单分片时已知精确大小，可作为最终校验基准；多分片只能依赖每次响应的 content-length。
  const knownShardTotal = shards.length === 1 ? totalBytes : 0;
  let received = 0;
  const startedAt = Date.now();
  let lastEmit = 0;

  const headers = (extra?: Record<string, string>): Record<string, string> => ({
    ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    ...extra,
  });

  const progressNow = (): DownloadEvent => {
    const elapsed = (Date.now() - startedAt) / 1000 || 1;
    const bps = received / elapsed;
    const eta = bps > 0 ? Math.max(0, (totalBytes - received) / bps) : 0;
    return { type: "progress", receivedBytes: received, totalBytes, bytesPerSec: bps, etaSec: eta };
  };

  for (let i = 0; i < shards.length; i++) {
    const fileName = shards[i]!;
    if (shards.length > 1) yield { type: "shard", index: i + 1, total: shards.length };

    const finalPath = path.join(opts.destDir, fileName);
    const partPath = `${finalPath}.part`;

    if (fs.existsSync(finalPath)) {
      received += fs.statSync(finalPath).size;
      continue;
    }

    const baseReceived = received; // 进入本分片前的累计
    let attempt = 0;
    for (;;) {
      attempt++;
      const startByte = fs.existsSync(partPath) ? fs.statSync(partPath).size : 0;
      received = baseReceived + startByte;

      const res = await fetchImpl(opts.resolveUrl(fileName), {
        headers: startByte > 0 ? headers({ range: `bytes=${startByte}-` }) : headers(),
        signal: opts.signal,
      });
      if (!res.ok || !res.body) {
        yield { type: "error", message: `下载失败 ${fileName}: ${res.status}` };
        return;
      }

      // 期望的本分片总大小：206 时 = startByte + remaining；200 时 = content-length。
      const contentLength = Number(res.headers.get("content-length") ?? "0");
      const append = res.status === 206 && startByte > 0;
      if (!append && startByte > 0) received = baseReceived; // 服务器忽略 Range → 从头来
      const fromContentLength = append ? startByte + contentLength : contentLength;
      const expectedShardSize = Math.max(fromContentLength, knownShardTotal);

      const out = fs.createWriteStream(partPath, { flags: append ? "a" : "w" });
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      let shortRead = false;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          out.write(Buffer.from(value));
          received += value.byteLength;
          if (Date.now() - lastEmit >= 200) {
            lastEmit = Date.now();
            yield progressNow();
          }
        }
      } catch {
        shortRead = true; // 网络异常 → 视为短读，保留 .part 续传
      } finally {
        await new Promise<void>((resolve) => out.end(() => resolve()));
        reader.releaseLock();
      }

      const writtenSize = fs.existsSync(partPath) ? fs.statSync(partPath).size : 0;
      // content-length 已知且写入不足 → 短读。
      if (expectedShardSize > 0 && writtenSize < expectedShardSize) shortRead = true;

      if (!shortRead) {
        fs.renameSync(partPath, finalPath);
        received = baseReceived + writtenSize;
        break;
      }

      if (attempt > maxRetries) {
        yield {
          type: "error",
          message: `下载 ${fileName} 多次短读失败（已写 ${writtenSize}/${expectedShardSize || "?"} 字节，保留 .part 可续传）`,
        };
        return;
      }
      // 退避后重试（从 .part 续传）。
      yield progressNow();
      await new Promise((r) => setTimeout(r, 300 * attempt));
    }
  }

  received = totalBytes;
  yield progressNow();
  yield { type: "verifying" };

  const primaryPath = path.join(opts.destDir, variant.fileName);
  const header = await readGGUFHeader(primaryPath).catch(() => null);
  if (header && !header.isGGUF) {
    yield { type: "error", message: `下载完成但 GGUF 头校验失败: ${primaryPath}` };
    return;
  }
  const model: LocalModel = {
    id: primaryPath,
    repoId: variant.repoId,
    path: primaryPath,
    fileName: variant.fileName,
    quant: variant.quant,
    sizeBytes: totalBytes,
    contextDefault: header?.contextLength,
    arch: header?.arch,
    hasVision: header?.hasVision ?? Boolean(variant.mmprojFile),
    source: "downloaded",
    addedAt: new Date(startedAt).toISOString(),
  };
  yield { type: "done", model };
}
