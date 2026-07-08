import { useCallback, useEffect, useRef, useState } from "react";
import type { ApprovalMode, ChatMessage, Project, ThinkLevel } from "@ew/shared";
import type { GitRemoteInfo, GitStatus, WsEntry } from "@ew/sdk";
import { getClient } from "../lib/client.js";
import { autoGrowComposer, focusComposerEnd, resetComposer } from "../lib/composer.js";
import {
  appendUserTurn,
  findLastUser,
  markLastAssistantCancelled,
  replaceLastAssistantTurn,
  toRunHistory,
  toUserContent,
  updateLastAssistant,
} from "../lib/message-runtime.js";
import { loadDisabledSkills, loadThink, saveThink } from "../lib/prefs.js";
import { MessageStream } from "../components/MessageStream.js";
import { ApprovalCard } from "../components/ApprovalCard.js";
import { ComposerContextPill, ComposerUsagePill } from "../components/ComposerContextStrip.js";
import { ContextBar } from "../components/ContextBar.js";
import { SideDock } from "../components/SideDock.js";
import { ModelSelect } from "../components/ModelSelect.js";
import { useSlashPalette } from "../components/SlashPalette.js";
import { THINK_LABEL, nextThink } from "../lib/slash.js";
import { useAvailableModel } from "../hooks/useAvailableModel.js";
import { useComposerImages } from "../hooks/useComposerImages.js";
import { useMessageScroll } from "../hooks/useMessageScroll.js";
import {
  applyAgentEvent,
  messageText,
  storedToUiMsgs,
  type PendingApproval,
  type StoredMsg,
  type UiMsg,
  type UiImage,
} from "../lib/agent-stream.js";
import {
  ArrowUpIcon,
  TerminalIcon,
  ShieldIcon,
  ChevronDownIcon,
  CheckIcon,
  PlusBtnIcon,
  ThinkIcon,
  SparkIcon,
  SearchIcon,
  WrenchIcon,
  FileIcon,
  FileImageIcon,
  StopIcon,
  XIcon,
} from "../icons.js";

const APPROVAL_OPTS: { id: ApprovalMode; label: string; desc: string }[] = [
  { id: "read-only", label: "只读", desc: "不写文件、不执行命令" },
  { id: "approve-each", label: "逐项确认", desc: "每次编辑与命令都需批准" },
  { id: "auto-edits", label: "自动编辑", desc: "编辑自动，命令需批准" },
  { id: "full-auto", label: "完全访问", desc: "编辑与命令全部自动执行" },
];
const APPROVAL_LABEL: Record<ApprovalMode, string> = Object.fromEntries(
  APPROVAL_OPTS.map((o) => [o.id, o.label]),
) as Record<ApprovalMode, string>;

const STARTERS: { label: string; prompt: string; Icon: typeof SparkIcon }[] = [
  { label: "先读代码库", prompt: "先快速浏览这个项目，告诉我它的结构、主要模块和启动方式。", Icon: SearchIcon },
  { label: "定位问题", prompt: "帮我定位一个问题：", Icon: WrenchIcon },
  { label: "改这个功能", prompt: "请直接帮我修改这个功能：", Icon: FileIcon },
  { label: "做个计划", prompt: "先别改代码，先给我一个实现计划：", Icon: SparkIcon },
];

export function Workspace({
  project,
  projects,
  models,
  contexts,
  threadId,
  onChanged,
  onThreadsChanged,
  onBranchChange,
  onSelectProject,
  onOpenFolder,
  dockOpen,
  setDockOpen,
}: {
  project: Project;
  /** 全部工作区（供 composer 上下文条切换）。 */
  projects: Project[];
  models: string[];
  contexts: Record<string, number>;
  /** 当前会话（由 App/会话列表 控制）。 */
  threadId: string;
  onChanged: () => void;
  /** 本轮结束后通知 App 刷新会话列表（标题/排序）。 */
  onThreadsChanged: () => void;
  /** 当前 git 分支变化 → 上报给 App（用于标题栏面包屑分支 pill）；非 git 仓库报 undefined。 */
  onBranchChange?: (branch?: string) => void;
  /** 上下文条切换工作区。 */
  onSelectProject: (id: string) => void;
  /** 上下文条「打开文件夹」新建工作区。 */
  onOpenFolder: () => void;
  dockOpen: boolean;
  setDockOpen: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  const { model, setModel } = useAvailableModel(models);
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>(project.approvalMode ?? "approve-each");
  const [permOpen, setPermOpen] = useState(false);
  const [msgs, setMsgs] = useState<UiMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [thinkLevel, setThinkLevel] = useState<ThinkLevel>("off");
  const [notice, setNotice] = useState<string | null>(null);
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  const [git, setGit] = useState<GitStatus>({ repo: false, files: [] });
  const [branch, setBranch] = useState<string | undefined>(undefined);
  const [branches, setBranches] = useState<string[]>([]);
  const [remote, setRemote] = useState<GitRemoteInfo>({ hasRemote: false, hasUpstream: false, ahead: 0, behind: 0 });
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [dockTarget, setDockTarget] = useState<{ path: string; nonce: number } | null>(null);
  const [wsFiles, setWsFiles] = useState<WsEntry[]>([]);
  const [usage, setUsage] = useState<{ promptTokens: number; completionTokens: number; totalTokens: number } | null>(
    null,
  );
  const { images, setImages, fileRef, onPickImages, onPasteImages } = useComposerImages();
  const { scrollRef, showJump, onMessagesScroll, jumpToBottom } = useMessageScroll(msgs);
  const abortRef = useRef<AbortController | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

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
  const contextLimit = contexts[model];
  const contextPct = contextLimit ? (((usage?.promptTokens ?? 0) / contextLimit) * 100) : null;
  const contextTitle =
    contextLimit == null
      ? undefined
      : usage
        ? `上下文已用 ${Math.round(contextPct ?? 0)}% · ${usage.promptTokens}/${contextLimit} tokens`
        : `上下文窗口 ${contextLimit} tokens`;
  const slash = useSlashPalette(input, setInput, {
    models,
    currentModel: model,
    currentThink: thinkLevel,
    usagePct: contextPct,
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
      const cur = s.repo ? b.current || s.branch || undefined : undefined;
      setBranch(cur);
      setBranches(s.repo ? b.all : []);
      onBranchChange?.(cur);
    } catch {
      setGit({ repo: false, files: [] });
      setBranch(undefined);
      setBranches([]);
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
    setUsage(null);
    let cancelled = false;
    void (async () => {
      try {
        const list = await getClient().threadMessages(threadId);
        if (cancelled) return;
        setMsgs(storedToUiMsgs(list as unknown as StoredMsg[]));
        const u = await getClient()
          .threadUsage(threadId)
          .catch(() => ({ usage: null }));
        if (!cancelled && u.usage) setUsage(u.usage);
      } catch {
        if (!cancelled) setMsgs([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [threadId]);

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
      resetComposer(taRef.current);
    }
    setBusy(true);
    const history: ChatMessage[] = toRunHistory(msgs);
    // 含图片时用多模态 content parts（走视觉模型）。
    const userContent: ChatMessage["content"] = toUserContent(text, sentImages);
    // 始终把本轮用户消息推进 history —— 后端据 history 末条取本轮 text/images（重新生成也要带原文）。
    history.push({ role: "user", content: userContent });
    if (over?.regenerate) {
      // 重新生成：UI 保留末条用户消息（编辑场景把其文本更新为本轮 text；普通重试 text 不变），
      // 移除其后旧助手回答，换成新的空助手（流式目标）。
      setMsgs((current) => replaceLastAssistantTurn(current, text));
    } else {
      setMsgs((current) => appendUserTurn(current, text, sentImages));
    }
    const apply = (fn: (m: UiMsg) => UiMsg) => setMsgs((current) => updateLastAssistant(current, fn));
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
        if (ev.type === "usage") setUsage(ev.usage);
        else if (ev.type === "approval-request") setApproval({ id: ev.id, toolName: ev.toolName, args: ev.args });
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
      apply((m) => (m.end ? m : { ...m, end: Date.now() })); // 盖本轮结束时刻 → 「已工作 N 分」
      setBusy(false);
      setNotice(null); // 本轮收尾即清掉瞬态提示，避免以工具/错误结尾时残留
    }
  };

  // 重新生成：用最后一条用户输入重跑（不动 composer），UI 替换旧回答，后端回滚上一轮保证上下文正确。
  const retry = () => {
    if (busy) return;
    const lastUser = findLastUser(msgs);
    if (!lastUser) return;
    void send({ text: lastUser.raw, images: lastUser.images ?? [], regenerate: true });
  };

  const stop = () => {
    abortRef.current?.abort();
    setApproval(null);
    setMsgs((current) => markLastAssistantCancelled(current));
  };
  // 编辑后重发：用改过的文本重跑（= 带新 text 的重新生成；保留原图）。
  const editRetry = (text: string) => {
    if (busy || !text.trim()) return;
    const lastUser = findLastUser(msgs);
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

  const empty = msgs.length === 0;
  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 6) return "夜深了，有什么想让我帮忙的吗";
    if (h < 12) return "上午好呀，有什么想让我帮忙的吗";
    if (h < 14) return "中午好，有什么想让我帮忙的吗";
    if (h < 18) return "下午好，有什么想让我帮忙的吗";
    return "晚上好，有什么想让我帮忙的吗";
  })();

  const switchBranch = (name: string) => {
    setNotice(`切换到分支 ${name}…`);
    void getClient()
      .gitSwitch(project.id, name)
      .then((r) => {
        setNotice(r.ok ? null : `切换失败：${r.error ?? "未知错误"}`);
        void refreshGit();
        void refreshWsFiles();
      })
      .catch(() => setNotice("切换分支失败"));
  };

  const startFrom = (prompt: string) => {
    setInput(prompt);
    requestAnimationFrame(() => focusComposerEnd(taRef.current));
  };

  const composer = (
    <footer className="composer">
          <ContextBar
            project={project}
            projects={projects}
            branch={branch}
            branches={branches}
            uncommitted={git.files.length}
            onSelectProject={onSelectProject}
            onOpenFolder={onOpenFolder}
            onSwitchBranch={switchBranch}
            onOpenGitGraph={() => setDockOpen(true)}
          >
            <ModelSelect models={models} value={model} onChange={setModel} up variant="strip" />
            <ComposerContextPill
              tone={thinkLevel !== "off" ? "on" : "default"}
              onClick={cycleThink}
              title="思考档位（点击循环：低/中/高/关）"
              testId="workspace-think-pill"
            >
              <ThinkIcon size={14} />
              <span>思考 {THINK_LABEL[thinkLevel]}</span>
            </ComposerContextPill>
            {contextPct != null && <ComposerUsagePill pct={contextPct} title={contextTitle} />}
          </ContextBar>
          <div className="composer-box">
            {images.length > 0 && (
              <div className="composer-images" data-testid="workspace-image-strip">
                {images.map((im, j) => (
                  <div key={j} className="cimg">
                    <img src={`data:${im.mimeType};base64,${im.data}`} alt="" />
                    <button data-testid={`workspace-image-remove-${j}`} onClick={() => setImages((cur) => cur.filter((_, k) => k !== j))}>
                      <XIcon size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <input
              ref={fileRef}
              data-testid="workspace-upload-input"
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
              ref={taRef}
              data-testid="workspace-composer-input"
              value={input}
              rows={1}
              placeholder={`在「${project.name}」里让 AI 干活…（/ 唤起命令）`}
              onChange={(e) => {
                setInput(e.target.value);
                autoGrowComposer(e.target);
              }}
              onPaste={onPasteImages}
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
              <div className="composer-bar-left">
                <button className="cbtn" data-testid="workspace-upload-button" title="上传图片" onClick={() => fileRef.current?.click()}>
                  <PlusBtnIcon size={18} />
                </button>
                {images.length > 0 && (
                  <span className="cmini-chip" data-testid="workspace-image-chip" title={`已附加 ${images.length} 张图片`}>
                    <FileImageIcon size={14} />
                    <span>{images.length} 张图</span>
                  </span>
                )}
              </div>
              <div className="composer-bar-right">
                <div className="perm-wrap">
                  <button
                    className={`perm-pill ${approvalMode === "full-auto" ? "warn" : ""}`}
                    data-testid="workspace-approval-pill"
                    onClick={() => setPermOpen((v) => !v)}
                    title="审批策略"
                  >
                    <ShieldIcon size={15} />
                    <span>{APPROVAL_LABEL[approvalMode]}</span>
                    <ChevronDownIcon size={13} className="perm-chev" />
                  </button>
                  {permOpen && (
                    <>
                      <div className="menu-backdrop" onClick={() => setPermOpen(false)} />
                      <div className="perm-menu up" data-testid="workspace-approval-menu">
                        {APPROVAL_OPTS.map((o) => (
                          <button
                            key={o.id}
                            className={`perm-item ${approvalMode === o.id ? "on" : ""}`}
                            data-testid={`workspace-approval-option-${o.id}`}
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
                {busy ? (
                  <button className="csend stop" onClick={stop} title="停止输出（本轮不计入上下文）">
                    <StopIcon size={15} fill="currentColor" />
                  </button>
                ) : (
                  <button className="csend" onClick={() => void send()} disabled={!model} title="发送">
                    <ArrowUpIcon size={18} />
                  </button>
                )}
              </div>
            </div>
            {notice && (
              <div className="composer-note">
                <span className="composer-status">{notice}</span>
              </div>
            )}
          </div>
        </footer>
  );

  return (
    <div className="workspace">
      <div className={`ws-main ${empty ? "empty-state" : ""}`}>
        {empty ? (
          <div className="ws-hero">
            <div className="ws-hero-mark">
              <TerminalIcon size={30} />
            </div>
            <h1 className="ws-hero-greet">{greeting}</h1>
            <p className="ws-hero-sub">
              在这里，AI 可以围绕当前项目读文件、改代码、跑命令和查看 git 改动。
            </p>
            <div className="greet-pills ws-starters">
              {STARTERS.map(({ label, prompt, Icon }) => (
                <button key={label} className="greet-pill" onClick={() => startFrom(prompt)}>
                  <Icon size={14} />
                  {label}
                </button>
              ))}
            </div>
            {composer}
          </div>
        ) : (
          <>
            <div className="messages" ref={scrollRef} onScroll={onMessagesScroll}>
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
            {showJump && (
              <button className="jump-bottom" title="跳到最新" onClick={jumpToBottom}>
                <ChevronDownIcon size={18} />
              </button>
            )}

            {approval && (
              <ApprovalCard toolName={approval.toolName} args={approval.args} onRespond={(v) => void respondApproval(v)} />
            )}
            {composer}
          </>
        )}
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
