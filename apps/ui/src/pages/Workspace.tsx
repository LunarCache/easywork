import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApprovalMode, Project, Skill, ThinkLevel } from "@ew/shared";
import type { GitRemoteInfo, GitStatus, ModelSourceInfo, WsEntry } from "@ew/sdk";
import { getClient } from "../lib/client.js";
import { autoGrowComposer, focusComposerEnd, resetComposer } from "../lib/composer.js";
import { loadDisabledSkills, loadThink, saveThink } from "../lib/prefs.js";
import { composerUsageState } from "../lib/context-usage.js";
import { MessageStream } from "../components/MessageStream.js";
import { ApprovalCard } from "../components/ApprovalCard.js";
import { ComposerContextPill, ComposerUsagePill } from "../components/ComposerContextStrip.js";
import { ContextBar } from "../components/ContextBar.js";
import { SideDock, type BrowserTarget } from "../components/SideDock.js";
import { ModelSelect } from "../components/ModelSelect.js";
import { useSlashPalette } from "../components/SlashPalette.js";
import { THINK_LABEL, nextThink } from "../lib/slash.js";
import { useAvailableModel } from "../hooks/useAvailableModel.js";
import { useComposerImages } from "../hooks/useComposerImages.js";
import { useMessageScroll } from "../hooks/useMessageScroll.js";
import { useAgentTurn } from "../hooks/useAgentTurn.js";
import { storedToUiMsgs, type StoredMsg, type UiImage } from "../lib/agent-stream.js";
import {
  ArrowUpIcon,
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
const MUTATING_TOOLS = new Set(["fs_write", "fs_edit", "run_command"]);

export function Workspace({
  project,
  projects,
  models,
  modelSources,
  skills,
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
  modelSources?: ModelSourceInfo[];
  skills?: Skill[];
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
  const [input, setInput] = useState("");

  useEffect(() => {
    const setPrompt = ((event: Event) => {
      const detail = (event as CustomEvent<{ prompt?: string; workspaceId?: string }>).detail;
      if (detail?.prompt && detail.workspaceId === project.id) setInput(detail.prompt);
    }) as EventListener;
    window.addEventListener("ew:set-composer-prompt", setPrompt);
    return () => window.removeEventListener("ew:set-composer-prompt", setPrompt);
  }, [project.id]);
  const [thinkLevel, setThinkLevel] = useState<ThinkLevel>("off");
  const [pageNotice, setPageNotice] = useState<string | null>(null);
  const [projectSkills, setProjectSkills] = useState<Skill[]>([]);
  const [git, setGit] = useState<GitStatus>({ repo: false, files: [] });
  const [branch, setBranch] = useState<string | undefined>(undefined);
  const [branches, setBranches] = useState<string[]>([]);
  const [remote, setRemote] = useState<GitRemoteInfo>({ hasRemote: false, hasUpstream: false, ahead: 0, behind: 0 });
  const [browserTarget, setBrowserTarget] = useState<BrowserTarget | null>(null);
  const [dockTarget, setDockTarget] = useState<{ path: string; nonce: number } | null>(null);
  const [wsFiles, setWsFiles] = useState<WsEntry[]>([]);
  const {
    messages: msgs,
    busy,
    notice: turnNotice,
    approval,
    usage,
    send: runTurn,
    retry,
    editRetry,
    stop,
    respondApproval,
    restore,
    setUsage,
  } = useAgentTurn({
    buildRequest: (history, regenerate) => {
      if (!model) return null;
      const excludeSkills = loadDisabledSkills();
      return {
        threadId,
        model,
        history,
        projectId: project.id,
        thinkingLevel: thinkLevel,
        ...(regenerate ? { regenerate: true } : {}),
        ...(excludeSkills.length ? { excludeSkills } : {}),
      };
    },
    beforeRun: async () => {
      if (pendingMode.current) await pendingMode.current.catch(() => {});
    },
    onToolEnd: (event) => {
      if (!MUTATING_TOOLS.has(event.call.name)) return;
      void refreshGit();
      void refreshWsFiles();
    },
    onComplete: () => {
      onChanged();
      void refreshGit();
      void refreshWsFiles();
      onThreadsChanged();
    },
  });
  const notice = turnNotice ?? pageNotice;
  const { images, setImages, fileRef, onPickImages, onPasteImages } = useComposerImages();
  const { scrollRef, showJump, onMessagesScroll, jumpToBottom } = useMessageScroll(msgs);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let alive = true;
    setProjectSkills([]);
    void getClient()
      .workspaceSkillsInfo(project.id)
      .then((info) => {
        if (alive) setProjectSkills(info.skills);
      })
      .catch(() => {
        if (alive) setProjectSkills([]);
      });
    return () => {
      alive = false;
    };
  }, [project.id]);

  const slashSkills = useMemo(() => {
    const byName = new Map<string, Skill>();
    for (const skill of skills ?? []) byName.set(skill.frontmatter.name, skill);
    for (const skill of projectSkills) byName.set(skill.frontmatter.name, skill);
    return [...byName.values()];
  }, [skills, projectSkills]);

  useEffect(() => {
    const fallback = modelSources?.find((source) => source.id === model)?.reasoning ? "medium" : "off";
    setThinkLevel(loadThink(model, fallback));
  }, [model, modelSources]);
  const changeThink = useCallback(
    (lv: ThinkLevel) => {
      setThinkLevel(lv);
      saveThink(model, lv);
    },
    [model],
  );
  const cycleThink = () => changeThink(nextThink(thinkLevel));
  const doCompact = useCallback(() => {
    setPageNotice("压缩上下文中…");
    void getClient()
      .compactThread(threadId)
      .then((r) => setPageNotice(r.skipped ? "无活动会话，已跳过压缩" : `已压缩 ${r.tokensBefore ?? "?"}→${r.tokensAfter ?? "?"} tokens`))
      .catch(() => setPageNotice("压缩失败"));
  }, [threadId]);
  const contextUsage = composerUsageState(usage, contexts[model], msgs);
  const contextPct = contextUsage.pct;
  const contextTitle = contextUsage.title;
  const slash = useSlashPalette(input, setInput, {
    models,
    modelSources,
    skills: slashSkills,
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
    // 与旧行为一致：加载完成前保留现有画面，只清理上一轮的在途状态和 usage。
    restore(msgs);
    let cancelled = false;
    void (async () => {
      try {
        const list = await getClient().threadMessages(threadId);
        if (cancelled) return;
        const messages = storedToUiMsgs(list as unknown as StoredMsg[]);
        restore(messages);
        const u = await getClient()
          .threadUsage(threadId)
          .catch(() => ({ usage: null }));
        if (!cancelled && u.usage) setUsage(u.usage);
      } catch {
        if (!cancelled) restore([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [threadId]);

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

  const send = (over?: { text: string; images: UiImage[]; regenerate?: boolean }) => {
    const text = (over?.text ?? input).trim();
    const sentImages = over?.images ?? images;
    if ((!text && sentImages.length === 0) || !model || busy) return;
    setPageNotice(null);
    if (!over) {
      // 普通发送才清空 composer；重试用上一次输入、不动输入框。
      setInput("");
      setImages([]);
      resetComposer(taRef.current);
    }
    void runTurn({ text, images: sentImages, regenerate: over?.regenerate });
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
    setPageNotice(`切换到分支 ${name}…`);
    void getClient()
      .gitSwitch(project.id, name)
      .then((r) => {
        setPageNotice(r.ok ? null : `切换失败：${r.error ?? "未知错误"}`);
        void refreshGit();
        void refreshWsFiles();
      })
      .catch(() => setPageNotice("切换分支失败"));
  };

  const startFrom = (prompt: string) => {
    setInput(prompt);
    requestAnimationFrame(() => focusComposerEnd(taRef.current));
  };

  const composer = (
    <footer className="composer">
      {showJump && !empty && (
        <button className="jump-bottom" title="跳到最新" onClick={jumpToBottom}>
          <ChevronDownIcon size={18} />
        </button>
      )}
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
        <ComposerContextPill
          tone={thinkLevel !== "off" ? "on" : "default"}
          onClick={cycleThink}
          title="思考档位（点击循环：低/中/高/关）"
          testId="workspace-think-pill"
        >
          <ThinkIcon size={14} />
          <span>思考 {THINK_LABEL[thinkLevel]}</span>
        </ComposerContextPill>
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
                {images.length > 0 && (
                  <span className="cmini-chip" data-testid="workspace-image-chip" title={`已附加 ${images.length} 张图片`}>
                    <FileImageIcon size={14} />
                    <span>{images.length} 张图</span>
                  </span>
                )}
              </div>
              <div className="composer-bar-right">
                <ModelSelect models={models} sources={modelSources} value={model} onChange={setModel} up align="right" variant="strip" />
                {contextPct != null && (
                  <ComposerUsagePill
                    pct={contextPct}
                    title={contextTitle}
                    parts={contextUsage.parts}
                    testId="workspace-context-usage"
                  />
                )}
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
            <h1 className="ws-hero-greet">{greeting}</h1>
            <p className="ws-hero-sub">当前工作区：{project.name}</p>
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
                  setBrowserTarget((current) => ({ url: u, nonce: (current?.nonce ?? 0) + 1 }));
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
        filesEmpty="暂无工作区文件。"
        browserTarget={browserTarget}
        target={dockTarget}
        git={{ projectId: project.id, status: git, remote, onRefresh: refreshGit }}
      />
    </div>
  );
}
