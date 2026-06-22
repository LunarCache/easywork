import { useEffect, useRef, useState } from "react";
import type { ApprovalMode, ChatMessage, Project } from "@ew/shared";
import type { GitRemoteInfo, GitStatus, WsEntry } from "@ew/sdk";
import { getClient } from "../lib/client.js";
import { loadDisabledSkills } from "../lib/prefs.js";
import { MessageStream } from "../components/MessageStream.js";
import { SideDock } from "../components/SideDock.js";
import {
  applyAgentEvent,
  messageText,
  modelLabel,
  splitThink,
  storedToUiMsgs,
  type PendingApproval,
  type StoredMsg,
  type UiMsg,
} from "../lib/agent-stream.js";
import { ArrowUpIcon, DiffIcon, GitBranchIcon, TerminalIcon, WrenchIcon } from "../icons.js";

const APPROVAL_LABELS: Record<ApprovalMode, string> = {
  "read-only": "只读",
  "approve-each": "逐次询问",
  "auto-edits": "自动改文件",
  "full-auto": "全自动",
};

export function Workspace({
  project,
  models,
  threadId,
  onChanged,
  onThreadsChanged,
}: {
  project: Project;
  models: string[];
  /** 当前会话（由 App/会话列表 控制）。 */
  threadId: string;
  onChanged: () => void;
  /** 本轮结束后通知 App 刷新会话列表（标题/排序）。 */
  onThreadsChanged: () => void;
}) {
  const [model, setModel] = useState(models[0] ?? "");
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>(project.approvalMode ?? "approve-each");
  const [msgs, setMsgs] = useState<UiMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  const [git, setGit] = useState<GitStatus>({ repo: false, files: [] });
  const [branches, setBranches] = useState<{ current: string; all: string[] }>({ current: "", all: [] });
  const [remote, setRemote] = useState<GitRemoteInfo>({ hasRemote: false, hasUpstream: false, ahead: 0, behind: 0 });
  const [dockOpen, setDockOpen] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [wsFiles, setWsFiles] = useState<WsEntry[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  if (model === "" && models.length > 0) setModel(models[0]!);

  const refreshWsFiles = async () => {
    try {
      setWsFiles(
        (await getClient().wsList(project.id, ".", 4))
          .filter((e) => e.type === "file")
          .sort((a, b) => a.path.localeCompare(b.path)),
      );
    } catch {
      setWsFiles([]);
    }
  };

  const refreshGit = async () => {
    try {
      const [s, b, rm] = await Promise.all([
        getClient().gitStatus(project.id),
        getClient().gitBranches(project.id),
        getClient().gitRemote(project.id),
      ]);
      setGit(s);
      setBranches(b);
      setRemote(rm);
    } catch {
      setGit({ repo: false, files: [] });
    }
  };

  // 切换工作区：同步审批档位 + 刷新 git。
  useEffect(() => {
    setApprovalMode(project.approvalMode ?? "approve-each");
    void refreshGit();
    void refreshWsFiles();
  }, [project.id]);

  // 切换/初始会话（threadId 由 App/会话列表 控制）→ 中断在途 + 载入历史。
  useEffect(() => {
    abortRef.current?.abort();
    setApproval(null);
    let cancelled = false;
    void (async () => {
      try {
        const list = await getClient().threadMessages(threadId);
        if (!cancelled) setMsgs(storedToUiMsgs(list as unknown as StoredMsg[]));
      } catch {
        if (!cancelled) setMsgs([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [msgs]);

  // 卸载（切换工作区会因 key 重挂载）时中断在途的 agent 流。
  useEffect(() => () => abortRef.current?.abort(), []);

  const setMode = async (m: ApprovalMode) => {
    setApprovalMode(m);
    try {
      await getClient().updateProject(project.id, { approvalMode: m });
      onChanged();
    } catch {
      /* ignore */
    }
  };

  const send = async () => {
    const text = input.trim();
    if (!text || !model || busy) return;
    setInput("");
    setBusy(true);
    const history: ChatMessage[] = msgs.map((m) => ({
      role: m.role,
      content: m.role === "assistant" ? splitThink(m.raw).answer : m.raw,
    }));
    history.push({ role: "user", content: text });
    setMsgs((m) => [
      ...m,
      { role: "user", raw: text, reasoning: "", tools: [], at: Date.now() },
      { role: "assistant", raw: "", reasoning: "", tools: [] },
    ]);
    const apply = (fn: (m: UiMsg) => UiMsg) =>
      setMsgs((cur) => {
        const next = cur.slice();
        next[next.length - 1] = fn(next[next.length - 1]!);
        return next;
      });
    const ac = new AbortController();
    abortRef.current = ac;
    const excludeSkills = loadDisabledSkills();
    const MUTATING = new Set(["fs_write", "fs_edit", "run_command"]);
    try {
      for await (const ev of getClient().runAgent(
        { threadId, model, history, projectId: project.id, ...(excludeSkills.length ? { excludeSkills } : {}) },
        { signal: ac.signal },
      )) {
        if (ev.type === "approval-request") setApproval({ id: ev.id, toolName: ev.toolName, args: ev.args });
        else if (ev.type === "final") apply((m) => (m.raw ? m : { ...m, raw: messageText(ev.message.content) }));
        else if (ev.type === "error") apply((m) => ({ ...m, raw: `${m.raw}\n\n[错误] ${ev.message}` }));
        else if (ev.type === "tool-end") {
          apply((m) => applyAgentEvent(m, ev));
          if (MUTATING.has(ev.call.name)) {
            void refreshGit(); // 仅改文件/执行命令的工具才刷新 git 面板
            void refreshWsFiles();
          }
        } else apply((m) => applyAgentEvent(m, ev));
      }
      onChanged();
      void refreshGit();
      void refreshWsFiles();
      onThreadsChanged();
    } catch (e) {
      if (!ac.signal.aborted)
        apply((m) => ({ ...m, raw: `${m.raw}\n\n[请求失败] ${e instanceof Error ? e.message : String(e)}` }));
    } finally {
      setBusy(false);
    }
  };

  const respondApproval = async (verdict: "approve" | "approve-always" | "deny") => {
    if (!approval) return;
    const id = approval.id;
    setApproval(null);
    try {
      await getClient().approveTool(id, verdict);
    } catch {
      /* ignore */
    }
  };

  const totalAdds = git.files.reduce((n, f) => n + f.adds, 0);
  const totalDels = git.files.reduce((n, f) => n + f.dels, 0);

  return (
    <div className="workspace">
      <div className="ws-main">
        <header className="bar ws-bar">
          <span className="ws-title" title={project.workspaceDir}>
            {project.name}
          </span>
          <span className="ws-sub">{project.workspaceDir}</span>
          <span className="bar-spacer" />
          {git.repo && (
            <span className="ws-branch" title="当前分支">
              <GitBranchIcon size={13} /> {branches.current || git.branch}
            </span>
          )}
          <select className="model-select" value={model} onChange={(e) => setModel(e.target.value)}>
            {models.length === 0 && <option value="">（无模型）</option>}
            {models.map((m) => (
              <option key={m} value={m}>
                {modelLabel(m)}
              </option>
            ))}
          </select>
          <button
            className={`ws-review-toggle ${dockOpen ? "on" : ""}`}
            onClick={() => setDockOpen((v) => !v)}
            title="工作台：改动 / 文件 / 终端 / 预览"
          >
            <DiffIcon size={14} /> 工作台
            {git.files.length > 0 && <span className="rev-count">{git.files.length}</span>}
            {(totalAdds > 0 || totalDels > 0) && (
              <span className="ws-stat">
                <span className="add">+{totalAdds}</span> <span className="del">-{totalDels}</span>
              </span>
            )}
          </button>
        </header>

        <div className="messages" ref={scrollRef}>
          {msgs.length === 0 && (
            <div className="empty">
              <div className="ring">
                <TerminalIcon size={26} />
              </div>
              <h2>工作区就绪</h2>
              <p>
                目录：<code>{project.workspaceDir}</code>
                <br />
                让 AI 读写文件、运行命令完成编码任务；右侧实时审阅改动。
              </p>
            </div>
          )}
          <MessageStream
            msgs={msgs}
            busy={busy}
            onOpenUrl={(u) => {
              setPreviewUrl(u);
              setDockOpen(true);
            }}
          />
        </div>

        <footer className="composer">
          <div className="composer-box">
            <textarea
              value={input}
              rows={1}
              placeholder={`在「${project.name}」里让 AI 干活…`}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <div className="composer-bar">
              <select
                className="perm-select"
                value={approvalMode}
                onChange={(e) => void setMode(e.target.value as ApprovalMode)}
                title="审批策略"
              >
                {(Object.keys(APPROVAL_LABELS) as ApprovalMode[]).map((m) => (
                  <option key={m} value={m}>
                    {APPROVAL_LABELS[m]}
                  </option>
                ))}
              </select>
              <span className="cspacer" />
              <button className="csend" onClick={() => void send()} disabled={busy || !model} title="发送">
                <ArrowUpIcon size={18} />
              </button>
            </div>
          </div>
        </footer>
      </div>

      <SideDock
        open={dockOpen}
        onClose={() => setDockOpen(false)}
        files={wsFiles}
        readFile={(p) => getClient().wsRead(project.id, p)}
        onFilesRefresh={() => void refreshWsFiles()}
        onRevealDir={() => void getClient().wsReveal(project.id)}
        filesEmpty="该工作区暂无可显示的文件。"
        msgs={msgs}
        exec={(c) => getClient().wsExec(project.id, c)}
        previewUrl={previewUrl}
        onClearPreview={() => setPreviewUrl(null)}
        git={{ projectId: project.id, status: git, remote, onRefresh: refreshGit }}
      />

      {approval && (
        <div className="approval-overlay">
          <div className="approval-card">
            <div className="approval-title">允许运行工具？</div>
            <div className="approval-tool">
              <WrenchIcon size={14} /> <b>{approval.toolName}</b>
            </div>
            <pre className="approval-args">{JSON.stringify(approval.args, null, 2)}</pre>
            <div className="approval-actions">
              <button className="btn-ghost" onClick={() => void respondApproval("deny")}>
                拒绝
              </button>
              <button className="btn-ghost" onClick={() => void respondApproval("approve-always")}>
                本会话总是允许
              </button>
              <button onClick={() => void respondApproval("approve")}>允许</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
