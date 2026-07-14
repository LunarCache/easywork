import fs from "node:fs";
import type { EasyWorkClient } from "@ew/sdk";
import type { AgentEvent, ChatMessage, ToolCall } from "@ew/shared";
import { c, err, isTTY, out, question } from "./term.js";

/** 选模型：显式 > EW_MODEL > 第一个 routed。无可用则报错。 */
export async function pickModel(client: EasyWorkClient, explicit?: string): Promise<string> {
  if (explicit) return explicit;
  if (process.env.EW_MODEL) return process.env.EW_MODEL;
  const info = await client.listModels();
  const m = info.routed[0];
  if (!m) {
    throw new Error(
      "没有可用模型。先 `easywork models pull <hf-id>` 或在桌面端配置云端 provider。",
    );
  }
  return m;
}

/** 把本地目录解析成一个 workspace project（已存在则复用，否则新建），返回 projectId。 */
export async function resolveProject(
  client: EasyWorkClient,
  workspaceDir: string,
): Promise<string> {
  const abs = fs.realpathSync(workspaceDir);
  const projects = await client.listProjects();
  const existing = projects.find((p) => {
    try {
      return p.workspaceDir && fs.realpathSync(p.workspaceDir) === abs;
    } catch {
      return false;
    }
  });
  if (existing) return existing.id;
  const created = await client.createProject({
    name: abs.split("/").pop() || abs,
    workspaceDir: abs,
  });
  return created.id;
}

function shortArgs(call: ToolCall): string {
  try {
    const a = JSON.parse(call.arguments) as Record<string, unknown>;
    const v = a.command ?? a.path ?? a.file_path ?? a.query ?? a.pattern ?? a.url;
    if (typeof v === "string") return v.length > 80 ? `${v.slice(0, 77)}…` : v;
  } catch {
    /* ignore */
  }
  return "";
}

function resultText(content: string | { type: string; text?: string }[]): string {
  if (typeof content === "string") return content;
  return content.map((p) => ("text" in p && p.text ? p.text : "")).join("");
}

export interface TurnResult {
  /** 助手最终消息（供拼回 history 续多轮）。 */
  message: ChatMessage | null;
  /** 是否出错。 */
  error?: string;
  /** 是否被用户 Ctrl-C 中断。 */
  aborted?: boolean;
}

export interface TurnOptions {
  model: string;
  threadId: string;
  history: ChatMessage[];
  projectId?: string;
  /** 自动批准所有工具调用（脚本 / --yes）。 */
  autoApprove?: boolean;
  signal?: AbortSignal;
}

/**
 * 跑一轮 agent，把事件渲染到终端，返回最终助手消息。
 * 约定：助手文本走 stdout（便于管道捕获）；工具/思考/状态等"装饰"走 stderr。
 */
export async function runTurn(client: EasyWorkClient, opts: TurnOptions): Promise<TurnResult> {
  let final: ChatMessage | null = null;
  let error: string | undefined;
  let reasoningOpen = false;

  const stream = client.runAgent(
    {
      threadId: opts.threadId,
      model: opts.model,
      history: opts.history,
      projectId: opts.projectId,
    },
    { signal: opts.signal },
  );

  const closeReasoning = () => {
    if (reasoningOpen) {
      err("");
      reasoningOpen = false;
    }
  };

  try {
    for await (const ev of stream as AsyncIterable<AgentEvent>) {
      switch (ev.type) {
        case "text":
          closeReasoning();
          process.stdout.write(ev.text);
          break;
        case "reasoning":
          if (!reasoningOpen) {
            process.stderr.write(c.gray("💭 "));
            reasoningOpen = true;
          }
          process.stderr.write(c.gray(ev.text));
          break;
        case "tool-start": {
          closeReasoning();
          const a = shortArgs(ev.call);
          err(`${c.cyan("⚙")} ${c.bold(ev.call.name)}${a ? c.dim(`  ${a}`) : ""}`);
          break;
        }
        case "tool-progress":
          process.stderr.write(c.dim(ev.chunk));
          break;
        case "tool-end": {
          const r = resultText(ev.result.content);
          if (ev.result.isError) err(c.red(`  ✗ ${r.slice(0, 200)}`));
          else if (r.trim()) err(c.dim(`  ✓ ${(r.split("\n")[0] ?? "").slice(0, 120)}`));
          break;
        }
        case "approval-request": {
          closeReasoning();
          if (opts.autoApprove) {
            await client.approveTool(ev.id, "approve");
            err(c.yellow(`  ↳ 自动批准 ${ev.toolName}`));
            break;
          }
          const ans = (
            await question(
              c.yellow(`  ? 批准工具 ${c.bold(ev.toolName)}? [y]es / [n]o / [a]lways: `),
            )
          ).toLowerCase();
          const verdict = ans === "a" ? "approve-always" : ans === "n" ? "deny" : "approve";
          await client.approveTool(ev.id, verdict);
          break;
        }
        case "memory-recall":
          if (ev.count > 0) err(c.dim(`  ↳ 召回 ${ev.count} 条记忆`));
          break;
        case "usage":
          if (isTTY)
            err(c.dim(`  · tokens in=${ev.usage.promptTokens} out=${ev.usage.completionTokens}`));
          break;
        case "artifacts":
          if (ev.artifacts.length > 0)
            err(c.dim(`  ↳ 本轮交付 ${ev.artifacts.map((artifact) => artifact.path).join(", ")}`));
          break;
        case "final":
          final = ev.message;
          break;
        case "error":
          closeReasoning();
          error = ev.message;
          err(c.red(`\n错误: ${ev.message}`));
          break;
      }
    }
  } catch (e) {
    closeReasoning();
    if (opts.signal?.aborted || (e as Error)?.name === "AbortError") {
      err(c.yellow("\n^C 已中断本轮"));
      return { message: null, aborted: true };
    }
    throw e;
  }
  closeReasoning();
  out(); // 收尾换行，分隔下一轮
  return { message: final, error };
}
