import fs from "node:fs";

/**
 * 最小 GGUF 头解析（best-effort）。
 * 只读文件前若干字节，解析 KV 直到 buffer 用尽（vocab 等大数组在 arch/context 之后，
 * 触及边界即停，返回已解析到的部分）。失败不抛出，返回 isGGUF 标志。
 *
 * GGUF 格式参考：magic "GGUF" + version(u32) + tensorCount(u64) + kvCount(u64) + KV...
 */

const GGUF_MAGIC = 0x46554747; // 'GGUF' little-endian when read as u32 LE → bytes 47 47 55 46

interface Cursor {
  buf: Buffer;
  off: number;
}

class TruncatedError extends Error {}

function ensure(c: Cursor, n: number): void {
  if (c.off + n > c.buf.length) throw new TruncatedError();
}

function u32(c: Cursor): number {
  ensure(c, 4);
  const v = c.buf.readUInt32LE(c.off);
  c.off += 4;
  return v;
}

function u64(c: Cursor): number {
  ensure(c, 8);
  const v = c.buf.readBigUInt64LE(c.off);
  c.off += 8;
  return Number(v);
}

function i64(c: Cursor): number {
  ensure(c, 8);
  const v = c.buf.readBigInt64LE(c.off);
  c.off += 8;
  return Number(v);
}

function gstr(c: Cursor): string {
  const len = u64(c);
  ensure(c, len);
  const s = c.buf.toString("utf8", c.off, c.off + len);
  c.off += len;
  return s;
}

// GGUF value types
const enum VT {
  UINT8 = 0,
  INT8 = 1,
  UINT16 = 2,
  INT16 = 3,
  UINT32 = 4,
  INT32 = 5,
  FLOAT32 = 6,
  BOOL = 7,
  STRING = 8,
  ARRAY = 9,
  UINT64 = 10,
  INT64 = 11,
  FLOAT64 = 12,
}

function readScalar(c: Cursor, vt: number): string | number | boolean {
  switch (vt) {
    case VT.UINT8:
      ensure(c, 1);
      return c.buf.readUInt8(c.off++);
    case VT.INT8:
      ensure(c, 1);
      return c.buf.readInt8(c.off++);
    case VT.UINT16: {
      ensure(c, 2);
      const v = c.buf.readUInt16LE(c.off);
      c.off += 2;
      return v;
    }
    case VT.INT16: {
      ensure(c, 2);
      const v = c.buf.readInt16LE(c.off);
      c.off += 2;
      return v;
    }
    case VT.UINT32:
      return u32(c);
    case VT.INT32: {
      ensure(c, 4);
      const v = c.buf.readInt32LE(c.off);
      c.off += 4;
      return v;
    }
    case VT.FLOAT32: {
      ensure(c, 4);
      const v = c.buf.readFloatLE(c.off);
      c.off += 4;
      return v;
    }
    case VT.BOOL:
      ensure(c, 1);
      return c.buf.readUInt8(c.off++) !== 0;
    case VT.STRING:
      return gstr(c);
    case VT.UINT64:
      return u64(c);
    case VT.INT64:
      return i64(c);
    case VT.FLOAT64: {
      ensure(c, 8);
      const v = c.buf.readDoubleLE(c.off);
      c.off += 8;
      return v;
    }
    default:
      throw new TruncatedError();
  }
}

/** 跳过/读取一个值（数组需完整遍历以保持 offset 正确）。返回标量值，数组返回 undefined。 */
function readValue(c: Cursor, vt: number): string | number | boolean | undefined {
  if (vt !== VT.ARRAY) return readScalar(c, vt);
  const elemType = u32(c);
  const count = u64(c);
  for (let i = 0; i < count; i++) readScalar(c, elemType);
  return undefined;
}

export interface GGUFMetadata {
  isGGUF: boolean;
  version?: number;
  arch?: string;
  contextLength?: number;
  hasVision?: boolean;
  kv: Record<string, string | number | boolean>;
}

export function parseGGUFBuffer(buf: Buffer): GGUFMetadata {
  const c: Cursor = { buf, off: 0 };
  const kv: Record<string, string | number | boolean> = {};
  const meta: GGUFMetadata = { isGGUF: false, kv };
  try {
    const magic = u32(c);
    if (magic !== GGUF_MAGIC) return meta;
    meta.isGGUF = true;
    meta.version = u32(c);
    u64(c); // tensorCount
    const kvCount = u64(c);
    for (let i = 0; i < kvCount; i++) {
      const key = gstr(c);
      const vt = u32(c);
      const val = readValue(c, vt);
      if (val !== undefined) kv[key] = val;
    }
  } catch (err) {
    if (!(err instanceof TruncatedError)) {
      // 非截断错误：返回已解析部分。
    }
  }

  const arch = kv["general.architecture"];
  if (typeof arch === "string") {
    meta.arch = arch;
    const ctx = kv[`${arch}.context_length`];
    if (typeof ctx === "number") meta.contextLength = ctx;
    if (kv[`${arch}.vision.embedding_length`] != null || arch.includes("clip")) {
      meta.hasVision = true;
    }
  }
  return meta;
}

/** 读取文件前 maxBytes 字节并解析 GGUF 头。 */
export async function readGGUFHeader(filePath: string, maxBytes = 2 * 1024 * 1024): Promise<GGUFMetadata> {
  const fh = await fs.promises.open(filePath, "r");
  try {
    const stat = await fh.stat();
    const len = Math.min(maxBytes, stat.size);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, 0);
    return parseGGUFBuffer(buf);
  } finally {
    await fh.close();
  }
}
