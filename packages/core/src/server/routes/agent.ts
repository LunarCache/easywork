import fs from "node:fs";
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
  type ContentPart,
} from "@ew/shared";
import type { EngineRegistry } from "../../engine/registry.js";
import type { ProviderManager } from "../../providers/manager.js";
import { chatWorkspaceDir } from "../../config/paths.js";
import { ToolTurnRecorder } from "../../agent/turn-recorder.js";
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
  /** 是否启用知识库 RAG（自动注入 + 暴露 search_knowledge_base）。默认关，由聊天「知识库」开关控制。 */
  kb: z.boolean().optional(),
  /** 选用的知识库集合 id；省略=跨全部集合。 */
  kbId: z.string().optional(),
  /** 工作区项目 id；解析其 workspaceDir + 审批策略，注入 fs/exec 工具。 */
  projectId: z.string().optional(),
});

const ApproveSchema = z.object({
  id: z.string(),
  verdict: z.enum(["approve", "approve-always", "deny"]),
});

export function registerAgentRoutes(ctx: CoreHttpContext): void {
  const { app, registry, providers, repo, sessionHost } = ctx;
  const approvalRegistry = new ApprovalRegistry();

  app.post("/agent/run", async (req, reply) => {
    const parsed = AgentRunSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", detail: parsed.error.format() });
    }
    const unavailable = agentModelUnavailableError(parsed.data.model, registry, providers);
    if (unavailable) {
      return reply.code(404).send({ error: "model_not_loaded", message: String(unavailable) });
    }

    // pi 内核托管：会话内自持历史/技能/compaction，并自行加载项目上下文（AGENTS.md）。
    // 记忆召回/抽取、知识库、MCP、内置工具均由宿主以扩展/customTools 注入（见 SessionHost）。
    const threadId = parsed.data.threadId;
    const projectId = parsed.data.projectId ?? repo.getThread(threadId)?.projectId ?? undefined;
    const project = projectId ? repo.getProject(projectId) : null;
    const isWorkspace = !!project?.workspaceDir;
    // 对话模式 cwd = 每会话工件目录（~/.easywork/workspace/chats/<threadId>），与其他会话隔离；
    // fs 工具读写均限定在此目录内，右侧「工件」面板按此目录展示本会话产出。
    const runWorkspaceDir = project?.workspaceDir ?? chatWorkspaceDir(threadId);
    // 工作区目录「真正聊天时」才落盘创建（新建工作区时不预建空目录）。
    try {
      fs.mkdirSync(runWorkspaceDir, { recursive: true });
    } catch {
      /* 目录创建失败由后续 fs 工具报错 */
    }

    // 持久化（应用内会话历史）：确保 thread 存在。本轮消息延迟到成功结束才落库——
    // 用户取消时整轮（用户消息 + 部分助手输出 + 工具往返）一律不计入历史/上下文。
    const lastUser = parsed.data.history[parsed.data.history.length - 1];
    const threadCreated = !repo.getThread(threadId);
    if (threadCreated) {
      const title = lastUser ? messageText(lastUser.content).slice(0, 40) || "新会话" : "新会话";
      repo.createThread({
        id: threadId,
        modelId: parsed.data.model,
        title,
        ...(projectId ? { projectId } : {}),
      });
    }
    let finalContent = "";

    const ac = new AbortController();
    reply.raw.on("close", () => ac.abort());
    reply.hijack();
    const raw = reply.raw;
    raw.on("error", () => {}); // 客户端断开后写 socket 不致命
    raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": req.headers.origin ?? "*",
    });
    const send = (ev: AgentEvent) => {
      if (!raw.writableEnded && !raw.destroyed) raw.write(`data: ${JSON.stringify(ev)}\n\n`);
    };
    // 交互式审批门：危险工具经 SSE approval-request 事件挂起，等 /agent/approve 解析。
    const runApproval = new SseApprovalGate({
      registry: approvalRegistry,
      emit: (ev) => send(ev),
      signal: ac.signal,
    });

    // 从事件流重建工具往返（assistant tool_calls + tool results），缓冲到本轮成功结束再落库。
    const recorder = new ToolTurnRecorder();
    const recorded: ReturnType<ToolTurnRecorder["push"]> = [];
    let sawFinal = false;

    const userText = lastUser?.role === "user" ? messageText(lastUser.content) : "";
    // 多模态：从本轮用户消息抽出图片片段（base64）→ 透传给 pi（视觉模型 mmproj）。
    // 仅取当前轮；历史轮的图片由 pi 会话上下文自持（按 threadId resume）。
    const userImages =
      lastUser?.role === "user" && Array.isArray(lastUser.content)
        ? lastUser.content.flatMap((p) =>
            p.type === "image" && typeof p.data === "string"
              ? [{ type: "image" as const, data: p.data, mimeType: p.mimeType }]
              : [],
          )
        : [];
    try {
      for await (const ev of sessionHost.run({
        threadId,
        modelId: parsed.data.model,
        text: userText,
        ...(userImages.length ? { images: userImages } : {}),
        cwd: runWorkspaceDir,
        // 工作区模式：按项目审批档位。对话模式：auto-edits —— 写在工作区内放行（escapesCwd 限定），
        // bash 经审批（可产出网页/构建等 artifacts，但每条命令需用户确认）。
        workspace: isWorkspace,
        // 记忆作用域：工作区会话用本工程私有池（隔离）；对话会话用全局池（共享）。
        memoryScope: isWorkspace && projectId ? workspaceScope(projectId) : GLOBAL_SCOPE,
        approval: runApproval,
        approvalMode: isWorkspace ? (project?.approvalMode ?? "approve-each") : "auto-edits",
        signal: ac.signal,
        ...(parsed.data.sampling ? { sampling: parsed.data.sampling } : {}),
        ...(parsed.data.thinkingLevel !== undefined ? { thinkingLevel: parsed.data.thinkingLevel } : {}),
        ...(parsed.data.regenerate ? { regenerate: true } : {}),
        ...(parsed.data.excludeSkills?.length ? { excludeSkills: parsed.data.excludeSkills } : {}),
      })) {
        recorded.push(...recorder.push(ev));
        if (ev.type === "final") {
          sawFinal = true;
          finalContent = messageText(ev.message.content);
        }
        send(ev);
      }
      // 仅在「未被取消」时落库：用户取消 → 整轮不计入历史（与 pi 上下文回滚一致）。
      if (sawFinal && !ac.signal.aborted) {
        if (lastUser?.role === "user") {
          repo.appendMessage({
            id: crypto.randomUUID(),
            threadId,
            role: "user",
            seq: repo.nextSeq(threadId),
            parts: normalizeContent(lastUser.content),
            createdAt: new Date().toISOString(),
          });
        }
        for (const m of recorded) {
          repo.appendMessage({
            id: crypto.randomUUID(),
            threadId,
            role: m.role,
            seq: repo.nextSeq(threadId),
            parts: m.parts,
            ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}),
            ...(m.toolResults ? { toolResults: m.toolResults } : {}),
            createdAt: new Date().toISOString(),
          });
        }
        // 收尾 assistant 消息：思考过程（reasoning）+ 答案。
        // 思考优先取 reasoning 事件（recorder 累计的收尾轮残留）；兜底剥离内联 <think>。
        let answer = finalContent;
        let inlineThink = "";
        if (answer.includes("<think>")) {
          answer = answer.replace(/<think>([\s\S]*?)<\/think>/g, (_m, t: string) => {
            inlineThink += t;
            return "";
          });
        }
        answer = answer.trim();
        // 先各自 trim 再取舍：避免"全空白的事件型 reasoning"短路掉真正有内容的内联 think。
        const reasoningText = recorder.trailingReasoning().trim() || inlineThink.trim();
        const finalParts: ContentPart[] = [
          ...(reasoningText ? [{ type: "reasoning" as const, text: reasoningText }] : []),
          ...(answer ? [{ type: "text" as const, text: answer }] : []),
        ];
        if (finalParts.length > 0) {
          repo.appendMessage({
            id: crypto.randomUUID(),
            threadId,
            role: "assistant",
            seq: repo.nextSeq(threadId),
            parts: finalParts,
            createdAt: new Date().toISOString(),
          });
        }
      } else if (threadCreated && repo.history(threadId).length === 0) {
        // 新建会话的首轮即被取消 → 清掉这个空会话，避免侧栏残留空壳。
        repo.deleteThread(threadId);
      }
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
