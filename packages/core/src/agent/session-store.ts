import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { promptTokensOf, type AgentTokenUsage, type PiUsage } from "./agent-usage.js";

type PersistedAssistantMessage = {
  role?: string;
  stopReason?: string;
  usage?: Partial<PiUsage>;
};

function isCompleteUsage(usage: Partial<PiUsage> | undefined): usage is PiUsage {
  if (!usage) return false;
  return (
    typeof usage.input === "number" &&
    typeof usage.output === "number" &&
    typeof usage.cacheRead === "number" &&
    typeof usage.cacheWrite === "number" &&
    typeof usage.totalTokens === "number"
  );
}

function isContextUsageMessage(
  message: PersistedAssistantMessage | undefined,
): message is PersistedAssistantMessage & { usage: PiUsage } {
  if (message?.role !== "assistant") return false;
  if (message.stopReason === "aborted" || message.stopReason === "error") return false;
  if (!isCompleteUsage(message.usage)) return false;
  return promptTokensOf(message.usage) + message.usage.output + message.usage.totalTokens > 0;
}

/**
 * Agent Runtime 的 session persistence seam：拥有 pi agentDir/sessionsDir、settings 调校、
 * SessionManager 创建/恢复，以及历史 usage 读取。
 */
export class AgentSessionStore {
  readonly agentDir: string;
  private readonly sessionsDir: string;

  constructor(agentDir?: string) {
    this.agentDir = agentDir ?? path.join(os.homedir(), ".easywork", "pi-agent");
    fs.mkdirSync(this.agentDir, { recursive: true });
    this.sessionsDir = path.join(this.agentDir, "sessions");
    fs.mkdirSync(this.sessionsDir, { recursive: true });
    this.tunePiSettings();
  }

  /**
   * 按 threadId 取/建持久化 SessionManager：文件存在则 open() 续接（跨重启/重建恢复
   * pi 上下文，含 compaction），否则 create() 后定向到该 threadId 文件。
   */
  sessionManagerFor(threadId: string, cwd: string): SessionManager {
    const file = this.sessionFileFor(threadId);
    if (fs.existsSync(file)) return SessionManager.open(file, this.sessionsDir, cwd);
    const sm = SessionManager.create(cwd, this.sessionsDir);
    sm.setSessionFile(file);
    return sm;
  }

  /**
   * 读该会话 pi 日志里最后一条 assistant 消息的 usage，用于打开历史会话时回填上下文用量环。
   */
  lastUsage(threadId: string): AgentTokenUsage | null {
    const file = this.sessionFileFor(threadId);
    if (!fs.existsSync(file)) return null;
    let last: AgentTokenUsage | null = null;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line) as { message?: PersistedAssistantMessage };
        const m = o.message;
        if (isContextUsageMessage(m)) {
          last = {
            promptTokens: promptTokensOf(m.usage),
            completionTokens: m.usage.output,
            totalTokens: m.usage.totalTokens,
          };
        }
      } catch {
        /* 跳过坏行 */
      }
    }
    return last;
  }

  deleteSessionFile(file: string | undefined): void {
    if (!file) return;
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* 删除会话文件失败不致命 */
    }
  }

  deleteSessionFileStrict(file: string | undefined): void {
    if (file) fs.rmSync(file, { force: true });
  }

  /** 删除尚未载入进程的 cold session 持久化文件。 */
  deleteThreadSessionFile(threadId: string): void {
    this.deleteSessionFileStrict(this.sessionFileFor(threadId));
  }

  private sessionFileFor(threadId: string): string {
    const file = path.resolve(this.sessionsDir, `${threadId}.jsonl`);
    if (path.dirname(file) !== this.sessionsDir) throw new Error("invalid_thread_id");
    return file;
  }

  /**
   * 调校 pi 设置（写 agentDir/settings.json，SettingsManager 启动时读取）。
   * pi 默认 compaction.reserveTokens=16384；本地小上下文模型会因此每轮压缩，调低到 2048。
   */
  private tunePiSettings(): void {
    const file = path.join(this.agentDir, "settings.json");
    try {
      const cur = fs.existsSync(file)
        ? (JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>)
        : {};
      const comp = (cur.compaction as Record<string, unknown> | undefined) ?? {};
      if (comp.reserveTokens == null) {
        cur.compaction = { ...comp, reserveTokens: 2048 };
        fs.writeFileSync(file, JSON.stringify(cur, null, 2), "utf8");
      }
    } catch {
      /* 设置写入失败不影响运行 */
    }
  }
}
