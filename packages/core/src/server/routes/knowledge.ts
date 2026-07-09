import fs from "node:fs";
import fsPath from "node:path";
import { z } from "zod";
import { parseFile } from "../../rag/parse.js";
import type { CoreHttpContext } from "../context.js";

interface KbJob {
  id: string;
  source: string;
  kbId: string;
  status: "queued" | "parsing" | "embedding" | "done" | "error";
  chunks?: number;
  done?: number;
  total?: number;
  error?: string;
  createdAt: string;
}

const KbIngestSchema = z.object({
  source: z.string().min(1),
  text: z.string().min(1),
  kbId: z.string().optional(),
});

const KbUploadSchema = z.object({
  source: z.string().min(1),
  contentBase64: z.string().min(1),
  kbId: z.string().optional(),
});

export function registerKnowledgeRoutes(ctx: CoreHttpContext): void {
  const { app, kb, skills, skillsDir } = ctx;
  const kbJobs: KbJob[] = []; // 最近在前，上限 100

  app.get("/kb/list", async () => ({ kbs: kb.listKbs() }));
  app.get("/kb/docs", async (req) => {
    const kbId = (req.query as { kbId?: string }).kbId;
    return { docs: kb.listDocs(kbId), chunks: kb.count(kbId) };
  });
  // 单文档正文（按 chunk 拼接）+ 元数据，供 UI 预览。
  app.get("/kb/docs/:id", async (req, reply) => {
    const doc = kb.docContent((req.params as { id: string }).id);
    if (!doc) return reply.code(404).send({ error: "not_found" });
    return { doc };
  });
  app.post("/kb/docs", async (req, reply) => {
    const parsed = KbIngestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_doc", detail: parsed.error.format() });
    }
    const doc = await kb.ingest(parsed.data);
    return { doc };
  });

  app.post("/kb/upload", async (req, reply) => {
    const parsed = KbUploadSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_upload", detail: parsed.error.format() });
    }
    const { source, contentBase64 } = parsed.data;
    const kbId = parsed.data.kbId ?? "default";
    const job: KbJob = { id: crypto.randomUUID(), source, kbId, status: "queued", createdAt: new Date().toISOString() };
    kbJobs.unshift(job);
    if (kbJobs.length > 100) kbJobs.length = 100;
    // 后台异步解析 → 分块 → 嵌入 → 入库（不阻塞响应）。
    void (async () => {
      try {
        job.status = "parsing";
        const buf = Buffer.from(contentBase64, "base64");
        const text = parseFile(source, buf);
        if (!text.trim()) throw new Error("解析结果为空");
        job.status = "embedding";
        const doc = await kb.ingest({ source, text, kbId }, (p) => {
          job.done = p.done;
          job.total = p.total;
        });
        job.chunks = doc.chunks;
        job.status = "done";
      } catch (e) {
        job.status = "error";
        job.error = e instanceof Error ? e.message : String(e);
      }
    })();
    return { jobId: job.id };
  });
  app.get("/kb/jobs", async () => ({ jobs: kbJobs.slice(0, 30) }));
  app.delete("/kb/docs/:id", async (req) => {
    kb.deleteDoc((req.params as { id: string }).id);
    return { ok: true };
  });
  app.get("/kb/search", async (req) => {
    const q = req.query as { q?: string; topK?: string; kbId?: string };
    const hits = await kb.retrieve(q.q ?? "", {
      ...(q.kbId ? { kbId: q.kbId } : {}),
      ...(q.topK ? { topK: Number(q.topK) } : {}),
    });
    return { hits };
  });

  app.get("/skills", async () => {
    await skills.discover().catch(() => {});
    return { skills: skills.list(), dir: skillsDir, sources: skills.sources() };
  });
  // 读取某技能的 SKILL.md 正文（懒加载；用于详情查看）。
  app.get("/skills/:id/body", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const skill = skills.list().find((s) => s.id === id);
    if (!skill) return reply.code(404).send({ error: "not_found" });
    try {
      const body = fs.readFileSync(skill.bodyPath, "utf8");
      return { body, bodyPath: skill.bodyPath };
    } catch (e) {
      return reply.code(500).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });
  // 在系统文件管理器中打开技能目录（本机桌面用）。
  app.post("/skills/open", async (_req, reply) => {
    try {
      fs.mkdirSync(skillsDir, { recursive: true });
      const cmd =
        process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
      const { spawn } = await import("node:child_process");
      spawn(cmd, [skillsDir], { detached: true, stdio: "ignore" }).unref();
      return { ok: true, dir: skillsDir };
    } catch (e) {
      return reply.code(500).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });
  // 新建一个 SKILL.md 模板（在技能目录下建子目录）。
  app.post("/skills/template", async (req, reply) => {
    const body = (req.body ?? {}) as { name?: string };
    const name = (body.name ?? "my-skill").replace(/[^a-zA-Z0-9._-]+/g, "-").toLowerCase() || "my-skill";
    const dir = fsPath.join(skillsDir, name);
    const file = fsPath.join(dir, "SKILL.md");
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (!fs.existsSync(file)) {
        fs.writeFileSync(
          file,
          `---
name: ${name}
description: 一句话说明这个技能做什么（会进系统提示目录）
whenToUse: 描述什么情况下模型应该调用 open_skill 加载本技能
version: "0.1.0"
---

# ${name}

在这里写技能正文：步骤、约定、示例。模型调用 open_skill("${name}") 时才会注入这部分内容。
`,
        );
      }
      await skills.discover().catch(() => {});
      return { ok: true, file };
    } catch (e) {
      return reply.code(500).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });
}
