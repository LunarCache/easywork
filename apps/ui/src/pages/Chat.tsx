import { useCallback, useEffect, useRef, useState } from "react";
import type { Skill, ThinkLevel } from "@ew/shared";
import type { ModelSourceInfo, WsEntry } from "@ew/sdk";
import { getClient } from "../lib/client.js";
import { autoGrowComposer, focusComposerEnd, resetComposer } from "../lib/composer.js";
import { MessageStream } from "../components/MessageStream.js";
import { ApprovalCard } from "../components/ApprovalCard.js";
import { ComposerContextPill, ComposerContextStrip, ComposerUsagePill } from "../components/ComposerContextStrip.js";
import { SideDock, type BrowserTarget } from "../components/SideDock.js";
import { TerminalPanel } from "../components/TerminalPanel.js";
import { ModelSelect } from "../components/ModelSelect.js";
import { useSlashPalette } from "../components/SlashPalette.js";
import { THINK_LABEL, nextThink } from "../lib/slash.js";
import { storedToUiMsgs, type StoredMsg, type UiImage } from "../lib/agent-stream.js";
import {
  loadDisabledSkills,
  loadThink,
  saveThink,
} from "../lib/prefs.js";
import { composerUsageState } from "../lib/context-usage.js";
import { useAvailableModel } from "../hooks/useAvailableModel.js";
import { useComposerImages } from "../hooks/useComposerImages.js";
import { useMessageScroll } from "../hooks/useMessageScroll.js";
import { useAgentTurn } from "../hooks/useAgentTurn.js";
import {
  ArrowUpIcon,
  BrainIcon,
  ChevronDownIcon,
  CodeIcon,
  FileIcon,
  GlobeIcon,
  PlusBtnIcon,
  FileImageIcon,
  SlidersIcon,
  SparkIcon,
  StopIcon,
  ThinkIcon,
  XIcon,
} from "../icons.js";

// 空态快捷起手式（点击预填输入框），仿 Claude 桌面端的 Code/Learn/Write/… pill。
const STARTERS: { label: string; prompt: string; Icon: typeof CodeIcon }[] = [
  { label: "写代码", prompt: "帮我写一个", Icon: CodeIcon },
  { label: "解释概念", prompt: "用通俗的话解释一下：", Icon: BrainIcon },
  { label: "总结文档", prompt: "帮我总结这段内容：\n\n", Icon: FileIcon },
  { label: "头脑风暴", prompt: "我想做一个项目，帮我头脑风暴一些点子：", Icon: SparkIcon },
];

const QUICK_ACTIONS: { label: string; action: "search" | "workspace" | "settings"; Icon: typeof GlobeIcon }[] = [
  { label: "联网搜索", action: "search", Icon: GlobeIcon },
  { label: "新建工作区", action: "workspace", Icon: FileIcon },
  { label: "配置模型", action: "settings", Icon: SlidersIcon },
];

// 工具卡 / 消息渲染已抽到 components/MessageStream.tsx（聊天与工作区共用）。

const DEMO = !!new URLSearchParams(location.search).get("demo");
const FILE_TOOLS = new Set(["fs_write", "fs_edit", "run_command"]);

export function Chat({
  models,
  modelSources,
  skills,
  contexts,
  threadId,
  onSaved,
  dockOpen,
  setDockOpen,
  terminalOpen,
  setTerminalOpen,
  onNewTask,
  terminalAvailable,
}: {
  models: string[];
  modelSources?: ModelSourceInfo[];
  skills?: Skill[];
  contexts: Record<string, number>;
  threadId: string;
  onSaved: () => void;
  dockOpen: boolean;
  setDockOpen: React.Dispatch<React.SetStateAction<boolean>>;
  terminalOpen: boolean;
  setTerminalOpen: React.Dispatch<React.SetStateAction<boolean>>;
  onNewTask: () => void;
  terminalAvailable: boolean;
}) {
  const { model, setModel } = useAvailableModel(models);
  const [input, setInput] = useState("");

  useEffect(() => {
    const setPrompt = ((event: Event) => {
      const detail = (event as CustomEvent<{ prompt?: string; workspaceId?: string }>).detail;
      if (detail?.prompt && !detail.workspaceId) setInput(detail.prompt);
    }) as EventListener;
    window.addEventListener("ew:set-composer-prompt", setPrompt);
    return () => window.removeEventListener("ew:set-composer-prompt", setPrompt);
  }, []);
  const [thinkLevel, setThinkLevel] = useState<ThinkLevel>("off");
  const [web, setWeb] = useState(true);
  const [pageNotice, setPageNotice] = useState<string | null>(null);

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
        excludeTools: web ? [] : ["explore_web", "http_get"],
        thinkingLevel: thinkLevel,
        ...(regenerate ? { regenerate: true } : {}),
        ...(excludeSkills.length ? { excludeSkills } : {}),
      };
    },
    onToolEnd: (event) => {
      if (FILE_TOOLS.has(event.call.name)) void refreshFiles();
    },
    onComplete: () => {
      onSaved();
      void refreshFiles();
    },
  });
  const notice = turnNotice ?? pageNotice;

  const learnCurrentConversation = async () => {
    try {
      const prepared = await getClient().prepareSkillLearning({ kind: "conversation", threadId });
      window.dispatchEvent(new CustomEvent("ew:learn-skill-compose", { detail: prepared }));
      setPageNotice("已生成 Skill 学习提示，请检查后发送");
    } catch (error) {
      setPageNotice(error instanceof Error ? error.message : "无法从当前对话学习");
    }
  };
  const { images, setImages, fileRef, onPickImages, onPasteImages } = useComposerImages();
  // 右侧「工件」面板：本会话目录下产出的文件（fs 工具写入 / 命令生成的网页/构建物）。
  const [files, setFiles] = useState<WsEntry[]>([]);
  const [browserTarget, setBrowserTarget] = useState<BrowserTarget | null>(null);
  // 点「文件改动」卡 → 工作台跳到该文件（{path, nonce} 让连点同一文件也触发）。
  const [dockTarget, setDockTarget] = useState<{ path: string; nonce: number } | null>(null);
  const autoOpenedRef = useRef(false);
  const { scrollRef, showJump, onMessagesScroll, jumpToBottom } = useMessageScroll(msgs);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const refreshFiles = useCallback(async () => {
    if (DEMO) return;
    try {
      setFiles((await getClient().chatFiles(threadId)).filter((e) => e.type === "file"));
    } catch {
      setFiles([]);
    }
  }, [threadId]);

  // 切换会话：重置面板 + 清空上下文用量（否则会沿用上个会话的 token 数 → 进度环显示错误百分比），拉取该会话已有工件。
  useEffect(() => {
    autoOpenedRef.current = false;
    setDockOpen(false);
    setFiles([]);
    setUsage(null);
    void refreshFiles();
  }, [refreshFiles]);

  // 本会话首次出现工件时，自动展开面板一次（之后由用户手动开关）。
  useEffect(() => {
    if (files.length > 0 && !autoOpenedRef.current) {
      autoOpenedRef.current = true;
      setDockOpen(true);
    }
  }, [files]);

  const openQuickAction = (action: "search" | "workspace" | "settings") => {
    if (action === "search") {
      setWeb(true);
      setInput("帮我搜索并总结一下：");
      requestAnimationFrame(() => focusComposerEnd(taRef.current));
      return;
    }
    if (action === "workspace") {
      window.dispatchEvent(new CustomEvent("ew:new-workspace"));
      return;
    }
    window.dispatchEvent(new CustomEvent("ew:open-settings", { detail: "models" }));
  };

  // 切换会话时加载历史（新会话 → 空）。
  useEffect(() => {
    if (DEMO) {
      const editUnified =
        "@@ -38,4 +38,6 @@\n   const rows = await db.query(sql, [workspaceId]);\n" +
        '-  res.setHeader("Content-Type", "text/csv");\n' +
        '-  res.send(rows.map(toCSV).join("\\n"));\n' +
        '+  if ((req.headers.accept ?? "").includes("text/csv"))\n' +
        "+    return streamCsv(res, workspaceId);\n" +
        '+  res.setHeader("Content-Type", "application/x-ndjson");\n' +
        "+  for await (const row of cursor.stream({ batchSize: 1000 }))\n" +
        '+    res.write(JSON.stringify(row) + "\\n");';
      const term =
        "$ npm test -- export.spec.ts\n\n" +
        "✓ export › streams NDJSON for large workspaces (118ms)\n" +
        "✓ export › paginates with cursor token (44ms)\n" +
        "✓ export › preserves CSV download path (31ms)\n\n" +
        "Test Files  1 passed (1)\n     Tests  12 passed (12)\n  Duration  1.92s";
      restore([
        { role: "user", raw: "/api/export 在大工作区会 504。改成流式 NDJSON + 游标分页，保留 CSV 下载。", reasoning: "", tools: [], displayAt: Date.now() },
        {
          role: "assistant",
          raw: "完成。`/api/export` 现在流式 NDJSON、按 `?cursor=` 分页，CSV 仍走缓冲路径（封顶 10k 行）。50k 行工作区峰值内存 **~480 MB → ~12 MB**。",
          reasoning: "先读现有 handler 定位缓冲点，再换成游标流式，最后跑测试。",
          tools: [],
          blocks: [
            { kind: "reasoning", text: "先读现有 handler 定位缓冲点，再换成游标流式，按 Accept 头分支保留 CSV，最后跑测试。", start: 0, end: 2000 },
            { kind: "text", text: "计划：\n1. 读现有 handler，找到一次性缓冲全量结果的地方\n2. 换成基于游标的流式\n3. 按 `Accept` 头分支，保留 CSV" },
            {
              kind: "tool",
              tool: {
                id: "s",
                name: "explore_web",
                args: '{"query":"node stream ndjson cursor pagination"}',
                status: "done",
                sources: [
                  { url: "https://nodejs.org/api/stream.html", title: "Stream | Node.js Docs" },
                  { url: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Accept", title: "Accept header - MDN" },
                ],
              },
            },
            { kind: "tool", tool: { id: "r", name: "fs_read", args: '{"path":"server/routes/export.ts"}', result: "142 行", status: "done" } },
            { kind: "text", text: "找到了——handler 把每一行 push 进单个数组再序列化，就是缓冲点。换成流式游标，并把 CSV 分流到限量路径。" },
            { kind: "tool", tool: { id: "e", name: "fs_write", args: '{"path":"server/routes/export.ts"}', status: "done", diff: { path: "server/routes/export.ts", before: null, after: "", unified: editUnified } } },
            { kind: "tool", tool: { id: "x", name: "run_command", args: '{"command":"npm test -- export.spec.ts"}', output: term, status: "done" } },
            { kind: "text", text: "完成。`/api/export` 现在流式 NDJSON、按 `?cursor=` 分页，CSV 仍走缓冲路径（封顶 10k 行）。50k 行工作区峰值内存 **~480 MB → ~12 MB**。" },
          ],
        },
      ]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const list = await getClient().threadMessages(threadId);
        if (cancelled) return;
        const messages = storedToUiMsgs(list as unknown as StoredMsg[]);
        restore(messages);
        // 回填该会话最后一轮的上下文用量 → 打开历史长会话即显示进度环（实测 token，含 system/记忆/工具开销）。
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

  // 切换模型 → 载入该模型的思考档位。
  useEffect(() => {
    const fallback = modelSources?.find((source) => source.id === model)?.reasoning ? "medium" : "off";
    setThinkLevel(loadThink(model, fallback));
  }, [model, modelSources]);

  // 改思考档位（按模型持久化）。
  const changeThink = useCallback(
    (lv: ThinkLevel) => {
      setThinkLevel(lv);
      saveThink(model, lv);
    },
    [model],
  );
  const cycleThink = () => changeThink(nextThink(thinkLevel));

  // /compact：手动压缩上下文。
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
    skills,
    currentModel: model,
    currentThink: thinkLevel,
    usagePct: contextPct,
    onThink: changeThink,
    onModel: setModel,
    onCompact: doCompact,
    onLearn: learnCurrentConversation,
  });

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

  return (
    <div className="chat-wrap" data-testid="chat-root" data-thread-id={threadId}>
      <div className="conversation-column">
      <div className={`chat ${msgs.length === 0 ? "is-empty" : ""}`}>
        <div className="messages" ref={scrollRef} onScroll={onMessagesScroll}>
          {msgs.length === 0 && (
            <div className="greeting">
              <span className="greet-spark">
                <SparkIcon size={30} />
              </span>
              <h1>有什么可以帮你？</h1>
              <p className="greet-sub">
                {model ? "直接输入，或从下面选一个起手式。" : "还没加载模型，先配置一下就能开始。"}
              </p>
              <div className="greet-pills">
                {STARTERS.map(({ label, prompt, Icon }) => (
                  <button
                    key={label}
                    className="greet-pill"
                    onClick={() => {
                      setInput(prompt);
                      requestAnimationFrame(() => focusComposerEnd(taRef.current));
                    }}
                  >
                    <Icon size={14} />
                    {label}
                  </button>
                ))}
              </div>
              <div className="greet-quick">
                {QUICK_ACTIONS.map(({ label, action, Icon }) => (
                  <button
                    key={label}
                    className="greet-quick-card"
                    data-testid={action === "workspace" ? "home-new-workspace" : undefined}
                    onClick={() => openQuickAction(action)}
                  >
                    <span className="greet-quick-ico">
                      <Icon size={15} />
                    </span>
                    <span className="greet-quick-label">{label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
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
        <footer className="composer">
          {showJump && (
            <button className="jump-bottom" title="跳到最新" onClick={jumpToBottom}>
              <ChevronDownIcon size={18} />
            </button>
          )}
          <div className="composer-box">
            <ComposerContextStrip>
              <ComposerContextPill
                tone={thinkLevel !== "off" ? "on" : "default"}
                onClick={cycleThink}
                title="思考档位（点击循环：低/中/高/关）"
                testId="chat-think-pill"
              >
                <ThinkIcon size={14} />
                <span>思考 {THINK_LABEL[thinkLevel]}</span>
              </ComposerContextPill>
              <ComposerContextPill
                tone={web ? "on" : "default"}
                onClick={() => setWeb((v) => !v)}
                title="联网搜索"
                testId="chat-web-pill"
              >
                <GlobeIcon size={14} />
                <span>{web ? "联网已开" : "联网已关"}</span>
              </ComposerContextPill>
            </ComposerContextStrip>
            {images.length > 0 && (
              <div className="composer-images" data-testid="chat-image-strip">
                {images.map((im, j) => (
                  <div key={j} className="cimg">
                    <img src={`data:${im.mimeType};base64,${im.data}`} alt="" />
                    <button data-testid={`chat-image-remove-${j}`} onClick={() => setImages((cur) => cur.filter((_, k) => k !== j))}>
                      <XIcon size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <input
              ref={fileRef}
              data-testid="chat-upload-input"
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
              data-testid="chat-composer-input"
              value={input}
              rows={1}
              placeholder="发送消息…（/ 唤起命令）"
              onChange={(e) => {
                setInput(e.target.value);
                autoGrowComposer(e.target);
              }}
              onPaste={onPasteImages}
              onKeyDown={(e) => {
                // 输入法组词中按回车只确认候选词，不发送（中文/日文等 IME）
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (slash.onKeyDown(e)) return; // 斜杠命令面板优先消费方向/回车/Esc
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <div className="composer-bar">
              <div className="composer-bar-left">
                <button className="cbtn" data-testid="chat-upload-button" title="上传图片" onClick={() => fileRef.current?.click()}>
                  <PlusBtnIcon size={18} />
                </button>
                {images.length > 0 && (
                  <span className="cmini-chip" data-testid="chat-image-chip" title={`已附加 ${images.length} 张图片`}>
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
                    testId="chat-context-usage"
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
          </div>
          {notice && (
            <div className="composer-note">
              <span className="composer-status">{notice}</span>
            </div>
          )}
        </footer>
      </div>
      <TerminalPanel
        open={terminalOpen}
        onClose={() => setTerminalOpen(false)}
        previewScope="chat"
        previewId={threadId}
      />
      </div>
      <SideDock
        open={dockOpen}
        files={files}
        previewScope="chat"
        previewId={threadId}
        onFilesRefresh={() => void refreshFiles()}
        onRevealDir={() => void getClient().chatReveal(threadId)}
        filesEmpty="暂无会话文件。"
        browserTarget={browserTarget}
        target={dockTarget}
        onNewTask={onNewTask}
        onOpenTerminal={terminalAvailable ? () => setTerminalOpen(true) : undefined}
      />
    </div>
  );
}
