// 本地文本推理端到端烟测：下载最小 instruct GGUF → 真实加载 → 流式推理。
// 用法：node scripts/smoke-local.mjs [repoId]
import { createCore } from "@ew/core";

const REPO = process.argv[2] ?? "unsloth/Qwen3-0.6B-GGUF";
const MODELS_DIR = process.env.EW_SMOKE_DIR ?? "/tmp/ew-smoke/models";

const PREFERRED = ["Q4_K_M", "Q4_0", "Q5_K_M", "Q8_0", "Q3_K_M", "Q2_K"];

function pickVariant(variants) {
  for (const q of PREFERRED) {
    const v = variants.find((x) => x.quant === q);
    if (v) return v;
  }
  // 退而求其次：排除 IQ1/IQ2（易乱码），取最小。
  const sane = variants.filter((v) => !/^IQ[12]/.test(v.quant));
  return (sane[0] ?? variants[0]);
}

const core = createCore({ modelsDir: MODELS_DIR });

console.log(`[smoke] 列出 ${REPO} 的变体...`);
const variants = await core.models.listVariants(REPO);
console.log(`[smoke] 共 ${variants.length} 个变体`);
const variant = pickVariant(variants);
console.log(`[smoke] 选中 ${variant.quant} (${(variant.sizeBytes / 1e6).toFixed(0)} MB) shards=${variant.shardCount}`);

console.log(`[smoke] 下载中...`);
let modelPath;
let lastPct = -1;
for await (const ev of core.models.download(variant)) {
  if (ev.type === "progress" && ev.totalBytes > 0) {
    const pct = Math.floor((ev.receivedBytes / ev.totalBytes) * 100);
    if (pct !== lastPct && pct % 10 === 0) {
      lastPct = pct;
      console.log(`  ${pct}%  (${(ev.bytesPerSec / 1e6).toFixed(1)} MB/s)`);
    }
  } else if (ev.type === "done") {
    modelPath = ev.model.path;
    console.log(`[smoke] 下载完成: ${modelPath}`);
    console.log(`[smoke] GGUF 元数据: arch=${ev.model.arch} ctx=${ev.model.contextDefault} vision=${ev.model.hasVision}`);
  } else if (ev.type === "error") {
    console.error(`[smoke] 下载错误: ${ev.message}`);
    process.exit(1);
  }
}

console.log(`[smoke] 加载模型(Metal)...`);
const t0 = Date.now();
const { id, contextSize } = await core.localEngine.load({ modelPath, contextSize: 2048 });
console.log(`[smoke] 已加载 id=${id} ctx=${contextSize} (${Date.now() - t0}ms)`);

// Qwen3 默认开启 thinking；用 /no_think 让它直接给答案，便于烟测观察。
const prompt = "用一句话解释什么是开源软件。/no_think";
console.log(`\n[smoke] 提问: ${prompt}\n[smoke] 回答: `);
let text = "";
const tStart = Date.now();
for await (const e of core.localEngine.chatStream({
  model: id,
  messages: [{ role: "user", content: prompt }],
  maxTokens: 256,
  temperature: 0.7,
})) {
  if (e.type === "text-delta") {
    process.stdout.write(e.text);
    text += e.text;
  } else if (e.type === "done") {
    process.stdout.write("\n");
  } else if (e.type === "error") {
    console.error(`\n[smoke] 推理错误: ${e.message}`);
    process.exit(1);
  }
}
const secs = (Date.now() - tStart) / 1000;
console.log(`\n[smoke] ✅ 成功：生成 ${text.length} 字符，用时 ${secs.toFixed(1)}s`);

await core.localEngine.unload(id);
process.exit(0);
