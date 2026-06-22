import fs from "node:fs";
import path from "node:path";
import { ensureDaemon } from "../daemon.js";
import { c, die, out } from "../term.js";

export async function kbList(): Promise<void> {
  const client = await ensureDaemon();
  const { kbs } = await client.kbList();
  if (!kbs.length) return out(c.dim("知识库为空 — `easywork kb add <文件>` 导入"));
  for (const k of kbs) out(`${c.cyan(k.kbId)}  ${c.dim(`${k.docs} 文档 · ${k.chunks} 块`)}`);
}

export async function kbSearch(query: string | undefined): Promise<void> {
  if (!query) die("用法: easywork kb search <关键词>");
  const client = await ensureDaemon();
  const { hits } = await client.kbSearch(query, 8);
  if (!hits.length) return out(c.dim("无检索结果"));
  for (const h of hits) {
    out(`${c.dim(`(${h.score.toFixed(2)})`)} ${c.cyan(h.source)}`);
    out(`  ${h.text.replace(/\s+/g, " ").slice(0, 200)}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function kbAdd(arg: string | undefined, kbId?: string): Promise<void> {
  if (!arg) die('用法: easywork kb add <文件路径|"文本"> [--kb <id>]');
  const client = await ensureDaemon();

  // 存在的文件 → base64 上传（daemon 解析 pdf/docx/md…），轮询任务到完成。
  if (fs.existsSync(arg) && fs.statSync(arg).isFile()) {
    const buf = await fs.promises.readFile(arg);
    const source = path.basename(arg);
    const { jobId } = await client.kbUpload({
      source,
      contentBase64: buf.toString("base64"),
      ...(kbId ? { kbId } : {}),
    });
    out(c.dim(`已入队 ${source}（job ${jobId.slice(0, 8)}）解析中…`));
    for (;;) {
      await sleep(600);
      const { jobs } = await client.kbJobs();
      const job = jobs.find((j) => j.id === jobId);
      if (!job) break;
      if (job.status === "done")
        return out(c.green(`✓ ${source} 已入库（${job.chunks ?? "?"} 块）`));
      if (job.status === "error") return die(`解析失败: ${job.error ?? "未知错误"}`);
    }
    return;
  }

  // 否则按内联文本处理。
  const { doc } = await client.kbIngest({ source: "inline", text: arg, ...(kbId ? { kbId } : {}) });
  out(c.green(`✓ 已入库 inline（${doc.chunks} 块，id ${doc.id.slice(0, 8)}）`));
}

export async function kbRemove(docId: string | undefined): Promise<void> {
  if (!docId) die("用法: easywork kb rm <docId>");
  const client = await ensureDaemon();
  await client.kbDeleteDoc(docId);
  out(c.green(`✓ 已删除文档 ${docId.slice(0, 8)}`));
}
