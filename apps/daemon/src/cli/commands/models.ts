import type { GGUFVariant, LocalModel } from "@ew/shared";
import { ensureDaemon } from "../daemon.js";
import { c, die, err, isTTY, out, question } from "../term.js";

function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}G`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return `${n}B`;
}

export async function modelsList(): Promise<void> {
  const client = await ensureDaemon();
  const [info, local] = await Promise.all([client.listModels(), client.localModels()]);
  out(c.bold("已路由（可直接用）:"));
  if (info.routed.length) for (const m of info.routed) out(`  ${c.green("●")} ${m}`);
  else out(c.dim("  （无）"));

  out("");
  out(c.bold("本地 GGUF:"));
  if (local.length) {
    for (const m of local) {
      const meta = [m.quant, fmtBytes(m.sizeBytes), m.hasVision ? "vision" : ""]
        .filter(Boolean)
        .join(" · ");
      out(`  ${c.cyan(m.id)}  ${c.dim(meta)}`);
    }
  } else {
    out(c.dim("  （无）— 用 `easywork models pull <hf-repo-id>` 下载"));
  }
}

async function pickVariant(variants: GGUFVariant[], wantQuant?: string): Promise<GGUFVariant> {
  if (wantQuant) {
    const m = variants.find((v) => v.quant.toLowerCase() === wantQuant.toLowerCase());
    if (!m) die(`没找到量化 ${wantQuant}。可用: ${variants.map((v) => v.quant).join(", ")}`);
    return m;
  }
  if (variants.length === 1) return variants[0]!;
  // 优先常用默认量化
  const pref = variants.find((v) => /^q4_k_m$/i.test(v.quant));
  if (pref && !isTTY) return pref;
  if (!isTTY) return variants[0]!;

  out(c.bold("可用量化:"));
  variants.forEach((v, i) => {
    const tag = pref && v === pref ? c.dim(" (默认)") : "";
    out(`  ${c.cyan(String(i + 1))}. ${v.quant}  ${c.dim(fmtBytes(v.sizeBytes))}${tag}`);
  });
  const ans = await question(`选择 [1-${variants.length}${pref ? "，回车=默认" : ""}]: `);
  if (!ans && pref) return pref;
  const idx = Number(ans) - 1;
  if (Number.isInteger(idx) && idx >= 0 && idx < variants.length) return variants[idx]!;
  die("无效选择");
}

function matchLocal(models: LocalModel[], needle: string): LocalModel[] {
  const n = needle.toLowerCase();
  const exact = models.filter((m) => m.id === needle);
  if (exact.length) return exact;
  return models.filter(
    (m) =>
      m.id.toLowerCase().includes(n) ||
      m.fileName.toLowerCase().includes(n) ||
      (m.repoId?.toLowerCase().includes(n) ?? false),
  );
}

export async function modelsRemove(needle: string | undefined, yes?: boolean): Promise<void> {
  if (!needle) die("用法: easywork models rm <模型名/路径片段> [-y]");
  const client = await ensureDaemon();
  const local = await client.localModels();
  const hits = matchLocal(local, needle);
  if (!hits.length) die(`没有匹配「${needle}」的本地模型。\`easywork models\` 看列表。`);
  if (hits.length > 1) {
    err(c.yellow(`「${needle}」匹配到多个，请更精确:`));
    for (const m of hits) err(`  ${m.fileName}  ${c.dim(m.id)}`);
    process.exitCode = 1;
    return;
  }
  const m = hits[0]!;
  if (!yes && isTTY) {
    const ans = (
      await question(`删除 ${c.cyan(m.fileName)} (${fmtBytes(m.sizeBytes)})? [y/N]: `)
    ).toLowerCase();
    if (ans !== "y" && ans !== "yes") return out(c.dim("已取消"));
  }
  const res = await client.deleteLocalModel(m.id);
  out(c.green(`✓ 已删除 ${m.fileName}（${res.removed.length} 个文件）`));
}

export async function modelsPull(repoId: string | undefined, wantQuant?: string): Promise<void> {
  if (!repoId) die("用法: easywork models pull <hf-repo-id> [--quant Q4_K_M]");
  const client = await ensureDaemon();
  err(c.dim(`解析 ${repoId} 的 GGUF 变体…`));
  const variants = await client.listVariants(repoId);
  if (!variants.length) die(`${repoId} 没有可用的 GGUF 变体`);
  const variant = await pickVariant(variants, wantQuant);

  out(`下载 ${c.cyan(repoId)} · ${variant.quant} (${fmtBytes(variant.sizeBytes)})`);
  for await (const ev of client.downloadModel(variant)) {
    switch (ev.type) {
      case "progress": {
        const pct = ev.totalBytes ? ((ev.receivedBytes / ev.totalBytes) * 100).toFixed(0) : "?";
        const line = `  ${pct}%  ${fmtBytes(ev.receivedBytes)}/${fmtBytes(ev.totalBytes)}  ${fmtBytes(ev.bytesPerSec)}/s  eta ${Math.round(ev.etaSec)}s`;
        if (isTTY) process.stdout.write(`\r${line}\x1b[K`);
        break;
      }
      case "shard":
        if (isTTY) process.stdout.write(`\r`);
        err(c.dim(`  分片 ${ev.index + 1}/${ev.total}`));
        break;
      case "verifying":
        if (isTTY) process.stdout.write(`\r`);
        err(c.dim("  校验中…"));
        break;
      case "done":
        if (isTTY) process.stdout.write(`\r\x1b[K`);
        out(c.green(`✓ 完成: ${ev.model.id}`));
        return;
      case "error":
        if (isTTY) process.stdout.write(`\r\x1b[K`);
        die(`下载失败: ${ev.message}`);
    }
  }
}
