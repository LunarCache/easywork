import { z } from "zod";
import {
  ChatMessageSchema,
  GLOBAL_SCOPE,
  SamplingParamsSchema,
  ThinkLevelSchema,
  messageText,
  normalizeContent,
  workspaceScope,
  type AgentEvent,
} from "@ew/shared";
import type { EngineRegistry } from "../../engine/registry.js";
import type { ProviderManager } from "../../providers/manager.js";
import { chatWorkspaceDir } from "../../config/paths.js";
import { ApprovalRegistry, SseApprovalGate } from "../../agent/approval-sse.js";
import type { CoreHttpContext } from "../context.js";

export function agentModelUnavailableError(
  modelId: string,
  registry: EngineRegistry,
  providers: ProviderManager,
): Error | null {
  if (providers.findByModel(modelId)) return null;
  try {
    registry.resolve(modelId);
    return null;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

const AgentRunSchema = z.object({
  threadId: z.string().default("default"),
  model: z.string(),
  history: z.array(ChatMessageSchema),
  excludeTools: z.array(z.string()).optional(),
  /** 禁用的 Skill 名称（按名过滤 pi resourceLoader 的 skills）。 */
  excludeSkills: z.array(z.string()).optional(),
  thinkingLevel: ThinkLevelSchema.optional(),
  regenerate: z.boolean().optional(),
  sampling: SamplingParamsSchema.optional(),
  /** 工作区项目 id；解析其 workspaceDir + 审批策略，注入 fs/exec 工具。 */
  projectId: z.string().optional(),
});

const ApproveSchema = z.object({
  id: z.string(),
  verdict: z.enum(["approve", "approve-always", "deny"]),
});

export function registerAgentRoutes(ctx: CoreHttpContext): void {
  const { app, registry, providers, repo, agentTurns } = ctx;
  const approvalRegistry = new ApprovalRegistry();

  app.post("/agent/run", async (req, reply) => {
    const parsed = AgentRunSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", detail: parsed.error.format() });
    }
    const threadId = parsed.data.threadId;
    if (agentTurns.isThreadDeleted(threadId)) {
      return reply.code(410).send({ error: "thread_deleted" });
    }
    const unavailable = agentModelUnavailableError(parsed.data.model, registry, providers);
    if (unavailable) {
      return reply.code(404).send({ error: "model_not_loaded", message: String(unavailable) });
    }

    // pi 内核托管：会话内自持历史/技能/compaction，并自行加载项目上下文（AGENTS.md）。
    // 记忆召回/抽取、MCP、内置工具均由宿主以扩展/customTools 注入（见 SessionHost）。
    const projectId = parsed.data.projectId ?? repo.getThread(threadId)?.projectId ?? undefined;
    const project = projectId ? repo.getProject(projectId) : null;
    const isWorkspace = !!project?.workspaceDir;
    // 对话模式 cwd = 每会话工件目录（~/.easywork/workspace/chats/<threadId>），与其他会话隔离；
    // fs 工具读写均限定在此目录内，右侧「工件」面板按此目录展示本会话产出。
    const runWorkspaceDir = project?.workspaceDir ?? chatWorkspaceDir(threadId);
    const lastUser = parsed.data.history[parsed.data.history.length - 1];
    const title = lastUser ? messageText(lastUser.content).slice(0, 40) || "新会话" : "新会话";
    const ac = new AbortController();
    reply.raw.on("close", () => ac.abort());
    const raw = reply.raw;
    const send = (ev: AgentEvent) => {
      if (!raw.writableEnded && !raw.destroyed) raw.write(`data: ${JSON.stringify(ev)}\n\n`);
    };
    // 交互式审批门：危险工具经 SSE approval-request 事件挂起，等 /agent/approve 解析。
    const runApproval = new SseApprovalGate({
      registry: approvalRegistry,
      emit: (ev) => send(ev),
      signal: ac.signal,
    });
    const execution = await agentTurns.start({
      source: {
        type: "thread",
        threadId,
        modelId: parsed.data.model,
        title,
        ...(projectId ? { projectId } : {}),
        runWorkspaceDir,
        workspace: isWorkspace,
        memoryScope: isWorkspace && projectId ? workspaceScope(projectId) : GLOBAL_SCOPE,
        approvalMode: isWorkspace ? (project?.approvalMode ?? "approve-each") : "auto-edits",
      },
      content: lastUser?.role === "user" ? normalizeContent(lastUser.content) : [],
      approval: runApproval,
      signal: ac.signal,
      ...(parsed.data.sampling ? { sampling: parsed.data.sampling } : {}),
      ...(parsed.data.thinkingLevel !== undefined ? { thinkingLevel: parsed.data.thinkingLevel } : {}),
      ...(parsed.data.regenerate ? { regenerate: true } : {}),
      ...(parsed.data.excludeSkills?.length ? { excludeSkills: parsed.data.excludeSkills } : {}),
      ...(parsed.data.excludeTools?.length ? { excludeTools: parsed.data.excludeTools } : {}),
      ...(!isWorkspace ? { trackArtifacts: true } : {}),
    });
    if (!execution) return reply.code(410).send({ error: "thread_deleted" });

    reply.hijack();
    raw.on("error", () => {}); // 客户端断开后写 socket 不致命
    raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": req.headers.origin ?? "*",
    });
    try {
      for await (const event of execution.events) send(event);
    } catch (err) {
      send({ type: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      if (!raw.writableEnded && !raw.destroyed) raw.write("data: [DONE]\n\n");
      try {
        raw.end();
      } catch {
        /* ignore */
      }
    }
  });

  // 工具审批回应：解析挂起的 approval-request（verdict: approve / approve-always / deny）。
  app.post("/agent/approve", async (req, reply) => {
    const parsed = ApproveSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_approval" });
    const ok = approvalRegistry.resolve(parsed.data.id, parsed.data.verdict);
    return { ok };
  });
}
