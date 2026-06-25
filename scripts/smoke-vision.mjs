// 多模态本地推理烟测：下载 SmolVLM 视觉模型 + mmproj → 启动 `llama serve` sidecar → 图片问答。
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { LlamaServeEngine } from "@ew/providers";

const REPO = "ggml-org/SmolVLM-256M-Instruct-GGUF";
const MODEL_FILE = "SmolVLM-256M-Instruct-Q8_0.gguf";
const MMPROJ_FILE = "mmproj-SmolVLM-256M-Instruct-Q8_0.gguf";
const DIR = "/tmp/ew-vision";

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([typeBuf, data])) >>> 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** 生成一张纯色 PNG（offline，无外部依赖）。 */
function makePng(w, h, [r, g, b]) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // 8-bit RGB
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const off = y * (1 + w * 3);
    raw[off] = 0;
    for (let x = 0; x < w; x++) {
      const p = off + 1 + x * 3;
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
    }
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

async function download(file) {
  const dest = path.join(DIR, file);
  const url = `https://huggingface.co/${REPO}/resolve/main/${file}`;
  if (fs.existsSync(dest)) {
    console.log(`[vision] 已存在 ${file} (${(fs.statSync(dest).size / 1e6).toFixed(0)}MB)`);
    return dest;
  }
  console.log(`[vision] 下载 ${file} ...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载失败 ${file}: ${res.status}`);
  const total = Number(res.headers.get("content-length") || 0);
  const out = fs.createWriteStream(dest);
  const reader = res.body.getReader();
  let recv = 0;
  let last = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    out.write(Buffer.from(value));
    recv += value.byteLength;
    if (total && recv - last > total / 5) {
      last = recv;
      console.log(`  ${Math.round((recv / total) * 100)}%`);
    }
  }
  await new Promise((r) => out.end(() => r()));
  if (total && fs.statSync(dest).size < total) throw new Error(`短读 ${file}`);
  console.log(`[vision] 完成 ${file}`);
  return dest;
}

fs.mkdirSync(DIR, { recursive: true });
const modelPath = await download(MODEL_FILE);
const mmprojPath = await download(MMPROJ_FILE);

console.log("[vision] 启动 `llama serve` (Metal, --mmproj) ...");
const engine = new LlamaServeEngine({
  modelPath,
  mmprojPath,
  gpuLayers: 99,
  contextSize: 4096,
  port: 8094,
  readyTimeoutMs: 90_000,
});
await engine.start();
console.log("[vision] 已就绪。能力:", engine.capabilities);

const png = makePng(96, 96, [220, 30, 30]).toString("base64");
console.log("[vision] 发送一张红色图片，提问其颜色...\n[vision] 回答: ");
let text = "";
for await (const ev of engine.chatStream({
  model: "local",
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "What is the dominant color of this image? Answer in one short sentence." },
        { type: "image", mimeType: "image/png", data: png },
      ],
    },
  ],
  maxTokens: 64,
})) {
  if (ev.type === "text-delta") {
    process.stdout.write(ev.text);
    text += ev.text;
  }
}
console.log(`\n[vision] ✅ 视觉推理成功，生成 ${text.length} 字符`);
await engine.stop();
process.exit(0);
