import { randomUUID } from "node:crypto";
import type { ChatMessage } from "@ew/shared";
import { ensureDaemon } from "../daemon.js";
import { pickModel, resolveProject, runTurn } from "../agent.js";
import { die } from "../term.js";

export interface RunFlags {
  model?: string;
  workspace?: string;
  yes?: boolean;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const ch of process.stdin) chunks.push(ch as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

/** 一次性问答：流式输出助手回复后退出（assistant 文本走 stdout，便于管道）。 */
export async function run(promptArg: string, flags: RunFlags): Promise<void> {
  const prompt = promptArg || (await readStdin());
  if (!prompt) die('用法: easywork run "你的问题" [--model M] [--workspace DIR] [--yes]');

  const client = await ensureDaemon();
  const model = await pickModel(client, flags.model);
  const projectId = flags.workspace ? await resolveProject(client, flags.workspace) : undefined;

  const history: ChatMessage[] = [{ role: "user", content: prompt }];
  const res = await runTurn(client, {
    model,
    threadId: randomUUID(),
    history,
    projectId,
    autoApprove: flags.yes,
  });
  if (res.error) process.exitCode = 1;
}
