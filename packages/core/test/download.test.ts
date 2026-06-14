import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DownloadEvent, GGUFVariant } from "@ew/shared";
import { downloadVariant } from "../src/models/download.js";

/** 构造最小合法 GGUF（magic+version+0 tensor+0 kv = 24 字节）。 */
function minimalGGUF(): Buffer {
  const b = Buffer.alloc(24);
  b.write("GGUF", 0, "ascii");
  b.writeUInt32LE(3, 4);
  b.writeBigUInt64LE(0n, 8); // tensorCount
  b.writeBigUInt64LE(0n, 16); // kvCount
  return b;
}

function streamOf(bytes: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(bytes));
      c.close();
    },
  });
}

let tmpDir: string | undefined;
function freshDir(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ew-dl-"));
  return tmpDir;
}

afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = undefined;
});

const variant: GGUFVariant = {
  repoId: "t/x",
  fileName: "m.gguf",
  quant: "Q4",
  sizeBytes: 24,
  shardCount: 1,
};

async function collect(it: AsyncIterable<DownloadEvent>): Promise<DownloadEvent[]> {
  const out: DownloadEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe("downloadVariant 大小校验 + 短读续传", () => {
  it("短读后保留 .part，重试时用 Range 续传并校验完整", async () => {
    const full = minimalGGUF();
    const destDir = freshDir();
    let calls = 0;
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      calls++;
      const range = (init?.headers as Record<string, string> | undefined)?.range;
      if (!range) {
        // 声称 24 字节但只发前 10 字节 → 短读。
        return new Response(streamOf(full.subarray(0, 10)), {
          status: 200,
          headers: { "content-length": "24" },
        });
      }
      // 续传 bytes=10- → 发剩余 14 字节。
      return new Response(streamOf(full.subarray(10)), {
        status: 206,
        headers: { "content-length": "14" },
      });
    }) as unknown as typeof fetch;

    const events = await collect(
      downloadVariant(variant, {
        destDir,
        resolveUrl: (f) => `http://x/${f}`,
        fetch: fakeFetch,
      }),
    );

    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    expect(calls).toBe(2); // 第一次短读 + 续传
    const finalFile = path.join(destDir, "m.gguf");
    expect(fs.statSync(finalFile).size).toBe(24);
    expect(fs.existsSync(`${finalFile}.part`)).toBe(false);
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("持续短读超过重试上限 → error，且 .part 保留可续传", async () => {
    const full = minimalGGUF();
    const destDir = freshDir();
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      const range = (init?.headers as Record<string, string> | undefined)?.range;
      const startByte = range ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? "0") : 0;
      // 永远只比已传多发 2 字节，凑不满 24。
      const end = Math.min(startByte + 2, full.length);
      return new Response(streamOf(full.subarray(startByte, end)), {
        status: range ? 206 : 200,
        headers: { "content-length": String(range ? end - startByte : 24) },
      });
    }) as unknown as typeof fetch;

    const events = await collect(
      downloadVariant(variant, {
        destDir,
        resolveUrl: (f) => `http://x/${f}`,
        fetch: fakeFetch,
        maxRetries: 1,
      }),
    );

    expect(events.at(-1)?.type).toBe("error");
    expect(fs.existsSync(path.join(destDir, "m.gguf"))).toBe(false); // 未 rename 成最终文件
    expect(fs.existsSync(path.join(destDir, "m.gguf.part"))).toBe(true); // .part 保留
  });
});
