import { describe, it, expect } from "vitest";
import {
  HFClient,
  HF_MIRROR_BASE,
  groupVariants,
  type HFFile,
} from "../src/models/hf.js";
import { enumerateShards } from "../src/models/download.js";
import { parseGGUFBuffer } from "../src/models/gguf.js";

describe("groupVariants (分片归组)", () => {
  it("把多分片归为一个逻辑变体", () => {
    const files: HFFile[] = [
      { path: "Qwen3-30B-Q4_K_M-00001-of-00003.gguf", size: 100 },
      { path: "Qwen3-30B-Q4_K_M-00002-of-00003.gguf", size: 100 },
      { path: "Qwen3-30B-Q4_K_M-00003-of-00003.gguf", size: 50 },
      { path: "Qwen3-30B-Q8_0.gguf", size: 400 },
      { path: "README.md", size: 10 },
    ];
    const variants = groupVariants("unsloth/Qwen3-30B-GGUF", files);
    expect(variants).toHaveLength(2);

    const sharded = variants.find((v) => v.shardCount === 3)!;
    expect(sharded.fileName).toBe("Qwen3-30B-Q4_K_M-00001-of-00003.gguf");
    expect(sharded.sizeBytes).toBe(250);
    expect(sharded.quant).toBe("Q4_K_M");

    const single = variants.find((v) => v.shardCount === 1)!;
    expect(single.quant).toBe("Q8_0");
    expect(single.sizeBytes).toBe(400);
  });

  it("识别 mmproj 并附加，不作为独立变体", () => {
    const files: HFFile[] = [
      { path: "model-Q4_K_M.gguf", size: 100 },
      { path: "mmproj-model-f16.gguf", size: 20 },
    ];
    const variants = groupVariants("x/y", files);
    expect(variants).toHaveLength(1);
    expect(variants[0]!.mmprojFile).toBe("mmproj-model-f16.gguf");
  });
});

describe("HFClient endpoint", () => {
  it("switches search, tree, and download URLs to the HF mirror", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const hf = new HFClient({ fetch: fetchImpl });

    hf.setBaseUrl(HF_MIRROR_BASE);
    await hf.search("qwen");
    await hf.listFiles("org/model");

    expect(urls).toEqual([
      expect.stringMatching(/^https:\/\/hf-mirror\.com\/api\/models\?/),
      "https://hf-mirror.com/api/models/org/model/tree/main?recursive=true",
    ]);
    expect(hf.resolveUrl("org/model", "model.gguf")).toBe(
      "https://hf-mirror.com/org/model/resolve/main/model.gguf",
    );
  });
});

describe("enumerateShards", () => {
  it("枚举全部分片名", () => {
    expect(enumerateShards("m-Q4-00001-of-00003.gguf", 3)).toEqual([
      "m-Q4-00001-of-00003.gguf",
      "m-Q4-00002-of-00003.gguf",
      "m-Q4-00003-of-00003.gguf",
    ]);
  });
  it("单文件返回自身", () => {
    expect(enumerateShards("m.gguf", 1)).toEqual(["m.gguf"]);
  });
});

describe("parseGGUFBuffer (最小 GGUF 头解析)", () => {
  function buildGGUF(): Buffer {
    const chunks: Buffer[] = [];
    const u32 = (n: number) => {
      const b = Buffer.alloc(4);
      b.writeUInt32LE(n);
      return b;
    };
    const u64 = (n: number) => {
      const b = Buffer.alloc(8);
      b.writeBigUInt64LE(BigInt(n));
      return b;
    };
    const gstr = (s: string) => {
      const sb = Buffer.from(s, "utf8");
      return Buffer.concat([u64(sb.length), sb]);
    };
    chunks.push(Buffer.from("GGUF", "ascii")); // magic
    chunks.push(u32(3)); // version
    chunks.push(u64(0)); // tensorCount
    chunks.push(u64(2)); // kvCount
    // KV1: general.architecture = "llama" (string=8)
    chunks.push(gstr("general.architecture"), u32(8), gstr("llama"));
    // KV2: llama.context_length = 4096 (uint32=4)
    chunks.push(gstr("llama.context_length"), u32(4), u32(4096));
    return Buffer.concat(chunks);
  }

  it("解析 magic / arch / context_length", () => {
    const meta = parseGGUFBuffer(buildGGUF());
    expect(meta.isGGUF).toBe(true);
    expect(meta.version).toBe(3);
    expect(meta.arch).toBe("llama");
    expect(meta.contextLength).toBe(4096);
  });

  it("非 GGUF 返回 isGGUF=false", () => {
    expect(parseGGUFBuffer(Buffer.from("NOPE....")).isGGUF).toBe(false);
  });

  it("截断 buffer 不抛错，返回已解析部分", () => {
    const full = buildGGUF();
    const meta = parseGGUFBuffer(full.subarray(0, 40));
    expect(meta.isGGUF).toBe(true); // magic 仍可读
  });
});
