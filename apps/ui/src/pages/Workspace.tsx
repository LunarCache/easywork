import { useCallback, useEffect, useRef, useState } from "react";
import type { ApprovalMode, ChatMessage, Project, ThinkLevel } from "@ew/shared";
import type { GitRemoteInfo, GitStatus, WsEntry } from "@ew/sdk";
import { getClient } from "../lib/client.js";
import { loadDisabledSkills, loadThink, saveThink } from "../lib/prefs.js";
import { MessageStream } from "../components/MessageStream.js";
import { SideDock } from "../components/SideDock.js";
import { ModelSelect } from "../components/ModelSelect.js";
import { useSlashPalette } from "../components/SlashPalette.js";
import { THINK_LABEL, nextThink } from "../lib/slash.js";
import {
  applyAgentEvent,
  messageText,
  splitThink,
  storedToUiMsgs,
  type PendingApproval,
  type StoredMsg,
  type UiMsg,
  type UiImage,
} from "../lib/agent-stream.js";
import {
  ArrowUpIcon,
  TerminalIcon,
  WrenchIcon,
  ShieldIcon,
  ChevronDownIcon,
  CheckIcon,
  PlusBtnIcon,
  ThinkIcon,
  XIcon,
} from "../icons.js";

const APPROVAL_OPTS: { id: ApprovalMode; label: string; desc: string }[] = [
  { id: "read-only", label: "Read only", desc: "No file writes or commands" },
  { id: "approve-each", label: "Ask each change", desc: "Approve every edit & command" },
  { id: "auto-edits", label: "Auto-edit files", desc: "Edits auto, commands ask" },
  { id: "full-auto", label: "Full auto", desc: "Edits & commands run automatically" },
];
const APPROVAL_LABEL: Record<ApprovalMode, string> = Object.fromEntries(
  APPROVAL_OPTS.map((o) => [o.id, o.label]),
) as Record<ApprovalMode, string>;

export function Workspace({
  project,
  models,
  threadId,
  onChanged,
  onThreadsChanged,
  onBranchChange,
  dockOpen,
  setDockOpen,
}: {
  project: Project;
  models: string[];
  /** 当前会话（由 App/会话列表 控制）。 */
  threadId: string;
  onChanged: () => void;
  /** 本轮结束后通知 App 刷新会话列表（标题/排序）。 */
  onThreadsChanged: () => void;
  /** 当前 git 分支变化 → 上报给 App（用于标题栏面包屑分支 pill）；非 git 仓库报 undefined。 */
  onBranchChange?: (branch?: string) => void;
  dockOpen: boolean;
  setDockOpen: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  const [model, setModel] = useState(models[0] ?? "");
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>(project.approvalMode ?? "approve-each");
  const [permOpen, setPermOpen] = useState(false);
  const [msgs, setMsgs] = useState<UiMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [thinkLevel, setThinkLevel] = useState<ThinkLevel>("off");
  const [notice, setNotice] = useState<string | null>(null);
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  const [git, setGit] = useState<GitStatus>({ repo: false, files: [] });
  const [remote, setRemote] = useState<GitRemoteInfo>({ hasRemote: false, hasUpstream: false, ahead: 0, behind: 0 });
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [dockTarget, setDockTarget] = useState<{ path: string; nonce: number } | null>(null);
  const [wsFiles, setWsFiles] = useState<WsEntry[]>([]);
  const [images, setImages] = useState<UiImage[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const onPickImages = async (files: FileList | null) => {
    if (!files) return;
    const next: UiImage[] = [];
    for (const f of Array.from(files)) {
      if (!f.type.startsWith("image/")) continue;
      const dataUrl = await new Promise<string>((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.readAsDataURL(f);
      });
      next.push({ mimeType: f.type, data: dataUrl.replace(/^data:[^;]+;base64,/, "") });
    }
    if (next.length) setImages((cur) => [...cur, ...next]);
  };

  // 模型列表变化时校正选中项：当前模型被卸载/移除 → 退回首个可用或清空。
  if (model && !models.includes(model)) setModel(models[0] ?? "");
  else if (model === "" && models.length > 0) setModel(models[0]!);

  useEffect(() => {
    setThinkLevel(loadThink(model));
  }, [model]);
  const changeThink = useCallback(
    (lv: ThinkLevel) => {
      setThinkLevel(lv);
      saveThink(model, lv);
    },
    [model],
  );
  const cycleThink = () => changeThink(nextThink(thinkLevel));
  const doCompact = useCallback(() => {
    setNotice("压缩上下文中…");
    void getClient()
      .compactThread(threadId)
      .then((r) => setNotice(r.skipped ? "无活动会话，已跳过压缩" : `已压缩 ${r.tokensBefore ?? "?"}→${r.tokensAfter ?? "?"} tokens`))
      .catch(() => setNotice("压缩失败"));
  }, [threadId]);
  const slash = useSlashPalette(input, setInput, {
    models,
    onThink: changeThink,
    onModel: setModel,
    onCompact: doCompact,
  });

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
      setRemote(rm);
      onBranchChange?.(s.repo ? b.current || s.branch || undefined : undefined);
    } catch {
      setGit({ repo: false, files: [] });
      onBranchChange?.(undefined);
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

  // 审批档位变更的在途 PATCH：send() 前 await，避免「切档即发送」用到旧档位（服务端按 project 读取）。
  const pendingMode = useRef<Promise<unknown> | null>(null);
  const setMode = (m: ApprovalMode) => {
    setApprovalMode(m);
    const p = getClient()
      .updateProject(project.id, { approvalMode: m })
      .then(() => onChanged())
      .catch(() => {
        /* ignore */
      });
    pendingMode.current = p;
  };

  const send = async (over?: { text: string; images: UiImage[]; regenerate?: boolean }) => {
    const text = (over?.text ?? input).trim();
    const sentImages = over?.images ?? images;
    if ((!text && sentImages.length === 0) || !model || busy) return;
    if (!over) {
      // 普通发送才清空 composer；重试用上一次输入、不动输入框。
      setInput("");
      setImages([]);
    }
    setBusy(true);
    const history: ChatMessage[] = msgs.map((m) => ({
      role: m.role,
      content: m.role === "assistant" ? splitThink(m.raw).answer : m.raw,
    }));
    // 含图片时用多模态 content parts（走视觉模型）。
    const userContent: ChatMessage["content"] =
      sentImages.length > 0
        ? [
            ...(text ? [{ type: "text" as const, text }] : []),
            ...sentImages.map((im) => ({ type: "image" as const, mimeType: im.mimeType, data: im.data })),
          ]
        : text;
    // 始终把本轮用户消息推进 history —— 后端据 history 末条取本轮 text/images（重新生成也要带原文）。
    history.push({ role: "user", content: userContent });
    if (over?.regenerate) {
      // 重新生成：UI 保留末条用户消息（编辑场景把其文本更新为本轮 text；普通重试 text 不变），
      // 移除其后旧助手回答，换成新的空助手（流式目标）。
      setMsgs((cur) => {
        const next = cur.slice();
        for (let k = next.length - 1; k >= 0; k--)
          if (next[k]!.role === "user") {
            next[k] = { ...next[k]!, raw: text };
            break;
          }
        while (next.length && next[next.length - 1]!.role === "assistant") next.pop();
        next.push({ role: "assistant", raw: "", reasoning: "", tools: [] });
        return next;
      });
    } else {
      setMsgs((m) => [
        ...m,
        { role: "user", raw: text, reasoning: "", tools: [], at: Date.now(), ...(sentImages.length ? { images: sentImages } : {}) },
        { role: "assistant", raw: "", reasoning: "", tools: [] },
      ]);
    }
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
    // 确保审批档位的在途 PATCH 已落库，再发起本轮（服务端按 project.approvalMode 把守危险工具）。
    if (pendingMode.current) await pendingMode.current.catch(() => {});
    try {
      for await (const ev of getClient().runAgent(
        { threadId, model, history, projectId: project.id, thinkingLevel: thinkLevel, ...(over?.regenerate ? { regenerate: true } : {}), ...(excludeSkills.length ? { excludeSkills } : {}) },
        { signal: ac.signal },
      )) {
        if (ev.type === "approval-request") setApproval({ id: ev.id, toolName: ev.toolName, args: ev.args });
        else if (ev.type === "retry") setNotice(`重试中 (${ev.attempt}/${ev.maxAttempts})…`);
        else if (ev.type === "compaction")
          setNotice(ev.phase === "start" ? "压缩上下文中…" : ev.ok === false ? "压缩未完成" : "已压缩上下文");
        else if (ev.type === "text" || ev.type === "reasoning") {
          setNotice(null);
          apply((m) => applyAgentEvent(m, ev));
        } else if (ev.type === "final") apply((m) => (m.raw ? m : { ...m, raw: messageText(ev.message.content) }));
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
      setNotice(null); // 本轮收尾即清掉瞬态提示，避免以工具/错误结尾时残留
    }
  };

  // 重新生成：用最后一条用户输入重跑（不动 composer），UI 替换旧回答，后端回滚上一轮保证上下文正确。
  const retry = () => {
    if (busy) return;
    const lastUser = [...msgs].reverse().find((m) => m.role === "user");
    if (!lastUser) return;
    void send({ text: lastUser.raw, images: lastUser.images ?? [], regenerate: true });
  };
  // 编辑后重发：用改过的文本重跑（= 带新 text 的重新生成；保留原图）。
  const editRetry = (text: string) => {
    if (busy || !text.trim()) return;
    const lastUser = [...msgs].reverse().find((m) => m.role === "user");
    void send({ text, images: lastUser?.images ?? [], regenerate: true });
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

  return (
    <div className="workspace">
      <div className="ws-main">
        <header className="bar ws-bar">
          <ModelSelect models={models} value={model} onChange={setModel} />
          <span className="bar-spacer" />
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
            onOpenFile={(p) => {
              setDockOpen(true);
              setDockTarget({ path: p, nonce: Date.now() });
            }}
            onRetry={retry}
            onEdit={editRetry}
          />
        </div>

        {approval && (
          <div className="approval-wrap">
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
        <footer className="composer">
          <div className="composer-box">
            {images.length > 0 && (
              <div className="composer-images">
                {images.map((im, j) => (
                  <div key={j} className="cimg">
                    <img src={`data:${im.mimeType};base64,${im.data}`} alt="" />
                    <button onClick={() => setImages((cur) => cur.filter((_, k) => k !== j))}>
                      <XIcon size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              style={{ display: "none" }}
              onChange={(e) => {
                void onPickImages(e.target.files);
                e.target.value = "";
              }}
            />
            {slash.palette}
            <textarea
              value={input}
              rows={1}
              placeholder={`在「${project.name}」里让 AI 干活…（/ 唤起命令）`}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                // 输入法组词中按回车只确认候选词，不发送（中文/日文等 IME）
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (slash.onKeyDown(e)) return;
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <div className="composer-bar">
              <button className="cbtn" title="上传图片（需视觉模型）" onClick={() => fileRef.current?.click()}>
                <PlusBtnIcon size={18} />
              </button>
              <button
                className={`cchip ${thinkLevel !== "off" ? "on" : ""}`}
                onClick={cycleThink}
                title="思考档位（点击循环：关/低/中/高）"
              >
                <ThinkIcon size={15} />
                <span className="cchip-lvl">{THINK_LABEL[thinkLevel]}</span>
              </button>
              <div className="perm-wrap">
                <button className="perm-pill" onClick={() => setPermOpen((v) => !v)} title="Approval policy">
                  <ShieldIcon size={15} />
                  <span>{APPROVAL_LABEL[approvalMode]}</span>
                  <ChevronDownIcon size={13} className="perm-chev" />
                </button>
                {permOpen && (
                  <>
                    <div className="menu-backdrop" onClick={() => setPermOpen(false)} />
                    <div className="perm-menu up">
                      {APPROVAL_OPTS.map((o) => (
                        <button
                          key={o.id}
                          className={`perm-item ${approvalMode === o.id ? "on" : ""}`}
                          onClick={() => {
                            void setMode(o.id);
                            setPermOpen(false);
                          }}
                        >
                          <div className="perm-item-main">
                            <span className="perm-item-label">{o.label}</span>
                            <span className="perm-item-desc">{o.desc}</span>
                          </div>
                          {approvalMode === o.id && <CheckIcon size={15} className="perm-item-check" />}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
              <span className="cspacer" />
              <button className="csend" onClick={() => void send()} disabled={busy || !model} title="发送">
                <ArrowUpIcon size={18} />
              </button>
            </div>
            {notice && <div className="composer-note"><span className="composer-status">{notice}</span></div>}
          </div>
        </footer>
      </div>

      <SideDock
        open={dockOpen}
        onClose={() => setDockOpen(false)}
        files={wsFiles}
        previewScope="workspace"
        previewId={project.id}
        onFilesRefresh={() => void refreshWsFiles()}
        onRevealDir={() => void getClient().wsReveal(project.id)}
        filesEmpty="该工作区暂无可显示的文件。"
        msgs={msgs}
        exec={(c) => getClient().wsExec(project.id, c)}
        previewUrl={previewUrl}
        onClearPreview={() => setPreviewUrl(null)}
        target={dockTarget}
        git={{ projectId: project.id, status: git, remote, onRefresh: refreshGit }}
      />
    </div>
  );
}
