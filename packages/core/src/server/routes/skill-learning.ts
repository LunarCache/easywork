import { SkillCandidateCreateSchema, SkillLearningSettingsSchema } from "@ew/shared";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { safeFetch } from "@ew/tools";
import type { CoreHttpContext } from "../context.js";

const LearnPrepareSchema = z.object({
  kind: z.enum(["text", "path", "url", "conversation"]),
  value: z.string().optional(),
  threadId: z.string().optional(),
  workspaceId: z.string().optional(),
});
const CandidateRevisionSchema = z.object({
  description: z.string().min(1).optional(),
  triggerConditions: z.array(z.string().min(1)).min(1).optional(),
  proposedSkillMd: z.string().min(1).optional(),
  packageFiles: z.record(z.string(), z.string()).optional(),
  reason: z.string().min(1).optional(),
}).strict();

function failure(reply: { code(statusCode: number): { send(body: unknown): unknown } }, error: unknown): unknown {
  const e = error as Error & { validation?: unknown };
  const status = e.message === "candidate_not_found" ? 404 : 400;
  return reply.code(status).send({ error: e.message || String(error), ...(e.validation ? { validation: e.validation } : {}) });
}

async function readBoundedText(response: Response, maxBytes = 256_000): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error("learn_url_too_large");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export function registerSkillLearningRoutes(ctx: CoreHttpContext): void {
  const { app, skillLifecycle, repo } = ctx;

  app.get("/skill-learning/status", async () => ({
    settings: skillLifecycle.settings(),
    status: skillLifecycle.status(),
  }));
  app.patch("/skill-learning/settings", async (req, reply) => {
    const patch = SkillLearningSettingsSchema.partial().safeParse(req.body ?? {});
    if (!patch.success) return reply.code(400).send({ error: "invalid_skill_learning_settings" });
    return { settings: skillLifecycle.updateSettings(patch.data) };
  });
  app.post("/skill-learning/review", async (req, reply) => {
    const requested = (req.body ?? {}) as { threadId?: string };
    const thread = requested.threadId
      ? repo.getThread(requested.threadId)
      : repo.listThreads()[0];
    if (!thread) return reply.code(404).send({ error: "conversation_not_found" });
    const history = repo.history(thread.id);
    const userText = [...history].reverse().find((message) => message.role === "user")?.parts
      .filter((part) => part.type === "text").map((part) => part.text).join("\n") ?? "";
    const finalText = [...history].reverse().find((message) => message.role === "assistant")?.parts
      .filter((part) => part.type === "text").map((part) => part.text).join("\n") ?? "";
    const calls = history.flatMap((message) => message.toolCalls ?? []);
    const results = history.flatMap((message) => message.toolResults ?? []);
    const toolCalls = calls.map((call, index) => ({ name: call.name, ok: results[index] ? !results[index]!.isError : false }));
    return skillLifecycle.review({
      threadId: thread.id,
      memoryScope: thread.projectId ? `ws:${thread.projectId}` : "global",
      model: thread.modelId,
      userText,
      finalText,
      toolCalls,
    });
  });
  app.post("/skill-learning/consolidate", async () => skillLifecycle.consolidate());

  app.post("/skill-learning/prepare", async (req, reply) => {
    const parsed = LearnPrepareSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_learn_input" });
    const input = parsed.data;
    let source = input.value?.trim() ?? "";
    try {
      if (input.kind === "conversation") {
        if (!input.threadId) throw new Error("thread_required");
        const history = repo.history(input.threadId);
        if (history.length === 0) throw new Error("conversation_not_found");
        source = history
          .slice(-40)
          .map((message) => `${message.role}: ${JSON.stringify(message.parts)}`)
          .join("\n")
          .slice(0, 40_000);
      } else if (input.kind === "path") {
        const project = input.workspaceId ? repo.getProject(input.workspaceId) : null;
        if (!project?.workspaceDir) throw new Error("workspace_required");
        if (!source) throw new Error("path_required");
        const root = fs.realpathSync(project.workspaceDir);
        const target = fs.realpathSync(path.resolve(root, source));
        if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error("learn_path_escape");
        const stat = fs.statSync(target);
        if (!stat.isFile()) throw new Error("learn_path_not_file");
        if (stat.size > 256_000) throw new Error("learn_path_too_large");
        source = fs.readFileSync(target, "utf8");
      } else if (input.kind === "url") {
        if (!source) throw new Error("url_required");
        const response = await safeFetch(source, {}, { fetchImpl: ctx.fetchImpl });
        if (!response.ok) throw new Error(`learn_url_http_${response.status}`);
        source = await readBoundedText(response);
      } else if (!source) {
        throw new Error("text_required");
      }
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
    const prompt = [
      "/learn 将下面材料提炼成可复用 Skill Candidate。",
      "先按 class-first 原则检查现有 Skills：优先补充已使用或已有的同类 Skill，只有没有归属时才创建新 Skill。",
      "区分事实与程序：事实不要写成 Skill。候选必须包含清晰触发条件、通用 Procedure、Pitfalls、Verification，以及真实依赖的命令/API/工具。",
      "去掉 secrets、临时路径、原始日志和一次性细节。完成后必须调用 stage_skill_candidate；不要直接写活跃 Skill 目录。",
      `材料类型：${input.kind}`,
      "--- MATERIAL ---",
      source,
      "--- END MATERIAL ---",
    ].join("\n\n");
    return { prompt, ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}) };
  });

  app.get("/skill-candidates", async () => ({ candidates: skillLifecycle.list() }));
  app.get("/skill-candidates/:id", async (req, reply) => {
    const candidate = skillLifecycle.get((req.params as { id: string }).id);
    return candidate ?? reply.code(404).send({ error: "candidate_not_found" });
  });
  app.get("/skill-candidates/:id/diff", async (req, reply) => {
    try {
      return { diff: skillLifecycle.diff((req.params as { id: string }).id) };
    } catch (error) {
      return failure(reply, error);
    }
  });
  app.post("/skill-candidates", async (req, reply) => {
    const parsed = SkillCandidateCreateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_candidate", detail: parsed.error.format() });
    try {
      return skillLifecycle.stage(parsed.data);
    } catch (error) {
      return failure(reply, error);
    }
  });
  app.patch("/skill-candidates/:id", async (req, reply) => {
    const patch = CandidateRevisionSchema.safeParse(req.body ?? {});
    if (!patch.success) return reply.code(400).send({ error: "invalid_candidate_revision" });
    try {
      return skillLifecycle.revise((req.params as { id: string }).id, patch.data);
    } catch (error) {
      return failure(reply, error);
    }
  });
  app.post("/skill-candidates/:id/scope", async (req, reply) => {
    const body = (req.body ?? {}) as { scope?: "global" | "workspace"; workspaceId?: string };
    if (body.scope !== "global" && body.scope !== "workspace") return reply.code(400).send({ error: "invalid_scope" });
    try {
      return skillLifecycle.changeScope((req.params as { id: string }).id, body.scope, body.workspaceId);
    } catch (error) {
      return failure(reply, error);
    }
  });
  app.post("/skill-candidates/:id/reject", async (req, reply) => {
    try {
      return skillLifecycle.reject(
        (req.params as { id: string }).id,
        (req.body as { reason?: string } | undefined)?.reason,
      );
    } catch (error) {
      return failure(reply, error);
    }
  });
  app.post("/skill-candidates/:id/approve", async (req, reply) => {
    try {
      return await skillLifecycle.approve((req.params as { id: string }).id);
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.get("/learned-skills", async () => ({ skills: skillLifecycle.listLearned() }));
  app.post("/learned-skills/:id/pin", async (req, reply) => {
    try {
      return skillLifecycle.pinLearned(
        (req.params as { id: string }).id,
        (req.body as { pinned?: boolean } | undefined)?.pinned ?? true,
      );
    } catch (error) {
      return failure(reply, error);
    }
  });
  app.post("/learned-skills/:id/feedback", async (req, reply) => {
    try {
      const body = (req.body ?? {}) as {
        outcome?: "success" | "failure" | "correction";
        sourceThreadId?: string;
        proposedSkillMd?: string;
        summary?: string;
      };
      if (!body.outcome) return reply.code(400).send({ error: "outcome_required" });
      return {
        candidate: skillLifecycle.stagePatchFromFeedback((req.params as { id: string }).id, {
          outcome: body.outcome,
          ...(body.sourceThreadId ? { sourceThreadId: body.sourceThreadId } : {}),
          ...(body.proposedSkillMd ? { proposedSkillMd: body.proposedSkillMd } : {}),
          ...(body.summary ? { summary: body.summary } : {}),
        }),
      };
    } catch (error) {
      return failure(reply, error);
    }
  });
  app.post("/learned-skills/:id/archive", async (req, reply) => {
    try {
      return skillLifecycle.archiveLearned((req.params as { id: string }).id);
    } catch (error) {
      return failure(reply, error);
    }
  });
  app.post("/learned-skills/:id/restore", async (req, reply) => {
    try {
      return skillLifecycle.restoreLearned((req.params as { id: string }).id);
    } catch (error) {
      return failure(reply, error);
    }
  });
  app.get("/learned-skills/:id/snapshots", async (req) => ({
    snapshots: skillLifecycle.listSnapshots((req.params as { id: string }).id),
  }));
  app.post("/learned-skills/:id/rollback", async (req, reply) => {
    const snapshotId = (req.body as { snapshotId?: string } | undefined)?.snapshotId;
    if (!snapshotId) return reply.code(400).send({ error: "snapshot_required" });
    try {
      return skillLifecycle.rollbackLearned((req.params as { id: string }).id, snapshotId);
    } catch (error) {
      return failure(reply, error);
    }
  });
  app.post("/skill-learning/curate", async () => ({ report: skillLifecycle.curate() }));
}
