import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { ApprovalMode, ChatMessage, Project } from "@ew/shared";
import type { GitCommit, GitFile, GitRemoteInfo, GitStatus, WsEntry } from "@ew/sdk";
import { getClient } from "../lib/client.js";
import { loadDisabledSkills } from "../lib/prefs.js";
import { MessageStream } from "../components/MessageStream.js";
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
import {
  ArrowUpIcon,
  ChevronIcon,
  CommitIcon,
  DiffIcon,
  DownloadIcon,
  GitBranchIcon,
  RefreshIcon,
  TerminalIcon,
  UndoIcon,
  UploadIcon,
  WrenchIcon,
  XIcon,
} from "../icons.js";

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
  const [reviewOpen, setReviewOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  if (model === "" && models.length > 0) setModel(models[0]!);

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
      { role: "user", raw: text, reasoning: "", tools: [] },
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
          if (MUTATING.has(ev.call.name)) void refreshGit(); // 仅改文件/执行命令的工具才刷新 git 面板
        } else apply((m) => applyAgentEvent(m, ev));
      }
      onChanged();
      void refreshGit();
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
            className={`ws-review-toggle ${reviewOpen ? "on" : ""}`}
            onClick={() => setReviewOpen((v) => !v)}
            title="审阅改动"
          >
            <DiffIcon size={14} /> 改动
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
          <MessageStream msgs={msgs} busy={busy} />
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

      <WorkspacePanel
        projectId={project.id}
        git={git}
        remote={remote}
        msgs={msgs}
        onRefresh={refreshGit}
        open={reviewOpen}
        onClose={() => setReviewOpen(false)}
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


// ===== 右侧 git 审查面板 =====
function WorkspacePanel({
  projectId,
  git,
  remote,
  msgs,
  onRefresh,
  open,
  onClose,
}: {
  projectId: string;
  git: GitStatus;
  remote: GitRemoteInfo;
  msgs: UiMsg[];
  onRefresh: () => Promise<void>;
  open: boolean;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"diff" | "files" | "terminal">("diff");
  const [commitMsg, setCommitMsg] = useState("");
  const [committing, setCommitting] = useState(false);
  const [netBusy, setNetBusy] = useState(false);
  const [netNote, setNetNote] = useState<{ ok: boolean; text: string } | null>(null);
  // 提交/拉取后自增 → 触发提交历史重新加载（若已展开）。
  const [historyNonce, setHistoryNonce] = useState(0);
  const staged = git.files.filter((f) => f.staged);
  const unstaged = git.files.filter((f) => f.unstaged);

  const act = async (fn: () => Promise<unknown>) => {
    await fn().catch(() => {});
    await onRefresh();
  };

  const commit = async () => {
    if (!commitMsg.trim() || staged.length === 0) return;
    setCommitting(true);
    try {
      const r = await getClient().gitCommit(projectId, commitMsg.trim());
      if (r.ok) {
        setCommitMsg("");
        setHistoryNonce((n) => n + 1);
      } else alert(`提交失败：${r.error ?? ""}`);
      await onRefresh();
    } finally {
      setCommitting(false);
    }
  };

  const net = async (kind: "push" | "pull") => {
    setNetBusy(true);
    setNetNote({ ok: true, text: kind === "push" ? "推送中…" : "拉取中…" });
    try {
      const r = kind === "push" ? await getClient().gitPush(projectId) : await getClient().gitPull(projectId);
      setNetNote({ ok: r.ok, text: r.message || (r.ok ? "完成" : "失败") });
      if (kind === "pull") setHistoryNonce((n) => n + 1);
      await onRefresh();
    } catch (e) {
      setNetNote({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setNetBusy(false);
    }
  };

  return (
    <aside className={`ws-review ${open ? "open" : ""}`}>
      <div className="wp-tabs">
        <button className={`wp-tab ${tab === "diff" ? "on" : ""}`} onClick={() => setTab("diff")}>
          Diff{git.files.length > 0 && <span className="rev-count">{git.files.length}</span>}
        </button>
        <button className={`wp-tab ${tab === "terminal" ? "on" : ""}`} onClick={() => setTab("terminal")}>
          Terminal
        </button>
        <button className={`wp-tab ${tab === "files" ? "on" : ""}`} onClick={() => setTab("files")}>
          Files
        </button>
        <span className="bar-spacer" />
        {tab === "diff" && (
          <button className="fv-btn" title="刷新" onClick={() => void onRefresh()}>
            <RefreshIcon size={13} />
          </button>
        )}
        <button className="fv-btn" title="关闭" onClick={onClose}>
          <XIcon size={14} />
        </button>
      </div>

      {tab === "files" && <FilesTab projectId={projectId} />}
      {tab === "terminal" && <TerminalTab msgs={msgs} />}

      {tab === "diff" && !git.repo && (
        <div className="rev-empty">
          该目录不是 git 仓库。运行 <code>git init</code> 后即可在此审阅改动。
        </div>
      )}

      {tab === "diff" && git.repo && (
        <>
      {remote.hasRemote && (
        <div className="rev-remote">
          <span className="rev-remote-info" title={remote.upstream}>
            {remote.hasUpstream ? remote.upstream : "未设上游"}
            {(remote.ahead > 0 || remote.behind > 0) && (
              <span className="rev-counts">
                {remote.ahead > 0 && <span className="add">↑{remote.ahead}</span>}
                {remote.behind > 0 && <span className="del">↓{remote.behind}</span>}
              </span>
            )}
          </span>
          <span className="bar-spacer" />
          <button className="rev-act" disabled={netBusy} onClick={() => void net("pull")} title="git pull --ff-only">
            <DownloadIcon size={12} /> 拉取
          </button>
          <button className="rev-act" disabled={netBusy} onClick={() => void net("push")} title="git push">
            <UploadIcon size={12} /> 推送
          </button>
        </div>
      )}
      {netNote && <div className={`rev-net-note ${netNote.ok ? "" : "err"}`}>{netNote.text}</div>}

      <div className="rev-scroll">
        {git.files.length === 0 && <div className="rev-empty">工作区干净，无改动。</div>}

        {unstaged.length > 0 && (
          <Group
            title="未暂存"
            count={unstaged.length}
            files={unstaged}
            projectId={projectId}
            staged={false}
            actions={
              <>
                <button className="rev-act" onClick={() => void act(() => getClient().gitStage(projectId))}>
                  全部暂存
                </button>
                <button className="rev-act danger" onClick={() => void act(() => getClient().gitRevert(projectId))}>
                  <UndoIcon size={12} /> 全部还原
                </button>
              </>
            }
            onAct={act}
          />
        )}

        {staged.length > 0 && (
          <Group
            title="已暂存"
            count={staged.length}
            files={staged}
            projectId={projectId}
            staged
            actions={
              <button className="rev-act" onClick={() => void act(() => getClient().gitUnstage(projectId))}>
                全部取消暂存
              </button>
            }
            onAct={act}
          />
        )}

        <CommitHistory projectId={projectId} nonce={historyNonce} />
      </div>

      {staged.length > 0 && (
        <div className="rev-commit">
          <textarea
            placeholder="提交说明…"
            value={commitMsg}
            rows={2}
            onChange={(e) => setCommitMsg(e.target.value)}
          />
          <button disabled={!commitMsg.trim() || committing} onClick={() => void commit()}>
            <CommitIcon size={14} /> 提交 {staged.length} 个文件
          </button>
        </div>
      )}
        </>
      )}
    </aside>
  );
}

/** 工作区文件树（wsList + wsRead 预览）。 */
function FilesTab({ projectId }: { projectId: string }) {
  const [entries, setEntries] = useState<WsEntry[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [data, setData] = useState<{ content?: string; binary?: boolean; truncated?: boolean; size: number } | null>(null);

  useEffect(() => {
    setSel(null);
    setData(null);
    void getClient()
      .wsList(projectId, ".", 4)
      .then((es) => setEntries(es.filter((e) => e.type === "file").sort((a, b) => a.path.localeCompare(b.path))))
      .catch(() => setEntries([]));
  }, [projectId]);

  const openFile = async (p: string) => {
    if (sel === p) {
      setSel(null);
      setData(null);
      return;
    }
    setSel(p);
    setData(null);
    try {
      setData(await getClient().wsRead(projectId, p));
    } catch {
      setData({ size: 0 });
    }
  };

  if (entries.length === 0) return <div className="rev-empty">该工作区暂无可显示的文件。</div>;
  return (
    <div className="rev-scroll">
      {entries.map((f) => (
        <div key={f.path} className="af-file">
          <div className={`af-file-head ${sel === f.path ? "open" : ""}`} onClick={() => void openFile(f.path)}>
            <ChevronIcon size={13} className={`chev ${sel === f.path ? "open" : ""}`} />
            <span className="af-path" title={f.path}>
              {f.path}
            </span>
          </div>
          {sel === f.path && (
            <div className="af-body">
              {!data ? (
                <div className="af-loading">加载中…</div>
              ) : data.binary ? (
                <div className="af-bin">二进制文件，无法预览</div>
              ) : (
                <pre className="af-code">
                  <code>{data.content || "（空文件）"}</code>
                </pre>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** 终端：展示最近一次 run_command 的输出。 */
function TerminalTab({ msgs }: { msgs: UiMsg[] }) {
  let last: { output?: string; result?: string; args: string } | undefined;
  for (const m of msgs) for (const b of m.blocks ?? []) if (b.kind === "tool" && b.tool.name === "run_command") last = b.tool;
  let cmd = "";
  try {
    cmd = (JSON.parse(last?.args || "{}") as { command?: string }).command ?? "";
  } catch {
    /* ignore */
  }
  if (!last) return <div className="rev-empty">还没有运行过命令。对话里让 AI 执行命令后，输出会显示在这里。</div>;
  return (
    <pre className="cv-term wp-term">
      {cmd && <div className="wp-term-cmd">$ {cmd}</div>}
      {last.output || last.result || "（无输出）"}
    </pre>
  );
}

/** 提交历史：折叠区，展开时懒加载 git log；nonce 变化（提交/拉取后）若已展开则刷新。 */
function CommitHistory({ projectId, nonce }: { projectId: string; nonce: number }) {
  const [open, setOpen] = useState(false);
  const [commits, setCommits] = useState<GitCommit[] | null>(null);

  const load = useCallback(async () => {
    try {
      setCommits(await getClient().gitLog(projectId, 30));
    } catch {
      setCommits([]);
    }
  }, [projectId]);

  useEffect(() => {
    if (open) void load();
  }, [open, nonce, load]);

  return (
    <div className="rev-group">
      <div className="rev-group-head rev-history-head" onClick={() => setOpen((v) => !v)}>
        <span className="rev-group-title">
          <ChevronIcon size={13} className={`chev ${open ? "open" : ""}`} /> 提交历史
        </span>
      </div>
      {open &&
        (commits === null ? (
          <div className="rev-empty">加载中…</div>
        ) : commits.length === 0 ? (
          <div className="rev-empty">还没有提交。</div>
        ) : (
          commits.map((c) => (
            <div key={c.hash} className="rev-commit-row" title={`${c.hash}\n${c.author} · ${c.relDate}`}>
              <code className="rev-chash">{c.shortHash}</code>
              <span className="rev-csubject">{c.subject}</span>
              <span className="rev-cmeta">{c.relDate}</span>
            </div>
          ))
        ))}
    </div>
  );
}

function Group({
  title,
  count,
  files,
  projectId,
  staged,
  actions,
  onAct,
}: {
  title: string;
  count: number;
  files: GitFile[];
  projectId: string;
  staged: boolean;
  actions: ReactNode;
  onAct: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  return (
    <div className="rev-group">
      <div className="rev-group-head">
        <span className="rev-group-title">
          {title} <span className="rev-count">{count}</span>
        </span>
        <span className="bar-spacer" />
        {actions}
      </div>
      {files.map((f) => (
        <FileRow
          key={`${staged ? "s" : "u"}:${f.path}:${f.adds}-${f.dels}`}
          file={f}
          projectId={projectId}
          staged={staged}
          onAct={onAct}
        />
      ))}
    </div>
  );
}

function FileRow({
  file,
  projectId,
  staged,
  onAct,
}: {
  file: GitFile;
  projectId: string;
  staged: boolean;
  onAct: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [diff, setDiff] = useState<string | null>(null);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && diff == null) {
      try {
        setDiff(await getClient().gitDiff(projectId, file.path, staged));
      } catch {
        setDiff("");
      }
    }
  };

  return (
    <div className="rev-file">
      <div className="rev-file-head" onClick={() => void toggle()}>
        <ChevronIcon size={13} className={`chev ${open ? "open" : ""}`} />
        <span className="rev-path" title={file.path}>
          {file.untracked ? "● " : ""}
          {file.path}
        </span>
        <span className="rev-stat">
          <span className="add">+{file.adds}</span> <span className="del">-{file.dels}</span>
        </span>
        <span className="rev-file-acts" onClick={(e) => e.stopPropagation()}>
          {staged ? (
            <button title="取消暂存" onClick={() => void onAct(() => getClient().gitUnstage(projectId, [file.path]))}>
              −
            </button>
          ) : (
            <>
              <button title="暂存" onClick={() => void onAct(() => getClient().gitStage(projectId, [file.path]))}>
                ＋
              </button>
              <button
                className="danger"
                title="还原"
                onClick={() => void onAct(() => getClient().gitRevert(projectId, [file.path]))}
              >
                <UndoIcon size={12} />
              </button>
            </>
          )}
        </span>
      </div>
      {open && diff != null && (
        <DiffView
          text={diff}
          projectId={projectId}
          path={file.path}
          staged={staged}
          untracked={file.untracked}
          onAct={onAct}
        />
      )}
    </div>
  );
}

interface DiffRow {
  type: "hunk" | "ctx" | "add" | "del";
  oldNo?: number;
  newNo?: number;
  text: string;
}

/** 解析 git unified diff → 带新旧行号的行（@@ hunk 驱动）。 */
function parseUnifiedDiff(text: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ "))
      continue;
    if (line.startsWith("@@")) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m) {
        oldNo = Number(m[1]);
        newNo = Number(m[2]);
      }
      rows.push({ type: "hunk", text: line });
      continue;
    }
    if (line.startsWith("\\")) continue; // \ No newline at end of file
    if (line.startsWith("+")) rows.push({ type: "add", newNo: newNo++, text: line.slice(1) });
    else if (line.startsWith("-")) rows.push({ type: "del", oldNo: oldNo++, text: line.slice(1) });
    else rows.push({ type: "ctx", oldNo: oldNo++, newNo: newNo++, text: line.startsWith(" ") ? line.slice(1) : line });
  }
  return rows;
}

function DiffView({
  text,
  projectId,
  path,
  staged,
  untracked,
  onAct,
}: {
  text: string;
  projectId: string;
  path: string;
  staged: boolean;
  untracked: boolean;
  onAct: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  if (!text.trim()) return <div className="diff-empty">（无文本 diff）</div>;
  const rows = parseUnifiedDiff(text);
  // 按 @@ 顺序给每个 hunk 编号；与后端 buildHunkPatch 的索引一致。
  let hunk = -1;
  const hunkOp = (hi: number, op: "stage" | "unstage" | "discard") =>
    void onAct(() => getClient().gitHunk(projectId, path, hi, op));
  return (
    <div className="diffview">
      {rows.map((r, i) => {
        if (r.type === "hunk") {
          hunk += 1;
          const hi = hunk;
          return (
            <div key={i} className="dv-hunk">
              <span className="dv-hunk-line">{r.text}</span>
              {/* untracked 整文件操作（FileRow 已有 +/还原），不做 per-hunk。 */}
              {!untracked && (
                <span className="dv-hunk-acts">
                  {staged ? (
                    <button onClick={() => hunkOp(hi, "unstage")}>取消暂存块</button>
                  ) : (
                    <>
                      <button onClick={() => hunkOp(hi, "stage")}>暂存块</button>
                      <button className="danger" onClick={() => hunkOp(hi, "discard")} title="从工作区丢弃此块（不可撤销）">
                        丢弃块
                      </button>
                    </>
                  )}
                </span>
              )}
            </div>
          );
        }
        return (
          <div key={i} className={`dv-row ${r.type}`}>
            <span className="dv-gutter">{r.oldNo ?? ""}</span>
            <span className="dv-gutter">{r.newNo ?? ""}</span>
            <span className="dv-sign">{r.type === "add" ? "+" : r.type === "del" ? "-" : " "}</span>
            <span className="dv-code">{r.text || " "}</span>
          </div>
        );
      })}
    </div>
  );
}
