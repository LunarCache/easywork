import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage } from "@ew/shared";
import type { WsEntry } from "@ew/sdk";
import { getClient } from "../lib/client.js";
import { MessageStream } from "../components/MessageStream.js";
import { SideDock } from "../components/SideDock.js";
import { ContextRing } from "../components/ContextRing.js";
import {
  applyAgentEvent,
  messageText,
  modelLabel,
  splitThink,
  storedToUiMsgs,
  type StoredMsg,
  type PendingApproval,
  type UiImage,
  type UiMsg,
} from "../lib/agent-stream.js";
import {
  loadSampling,
  saveSampling,
  samplingToRequest,
  loadAgentPrefs,
  loadDisabledSkills,
  type Sampling,
} from "../lib/prefs.js";
import {
  ArrowUpIcon,
  BoxIcon,
  BrainIcon,
  ChevronIcon,
  CodeIcon,
  FileCodeIcon,
  FileIcon,
  GlobeIcon,
  MicIcon,
  PlusBtnIcon,
  SlidersIcon,
  SparkIcon,
  StopIcon,
  ThinkIcon,
  WrenchIcon,
  XIcon,
} from "../icons.js";

// 空态快捷起手式（点击预填输入框），仿 Claude 桌面端的 Code/Learn/Write/… pill。
const STARTERS: { label: string; prompt: string; Icon: typeof CodeIcon }[] = [
  { label: "写代码", prompt: "帮我写一个", Icon: CodeIcon },
  { label: "解释概念", prompt: "用通俗的话解释一下：", Icon: BrainIcon },
  { label: "总结文档", prompt: "帮我总结这段内容：\n\n", Icon: FileIcon },
  { label: "头脑风暴", prompt: "我想做一个项目，帮我头脑风暴一些点子：", Icon: SparkIcon },
];

// 工具卡 / 消息渲染已抽到 components/MessageStream.tsx（聊天与工作区共用）。

const DEMO = !!new URLSearchParams(location.search).get("demo");

export function Chat({
  models,
  contexts,
  threadId,
  onSaved,
}: {
  models: string[];
  contexts: Record<string, number>;
  threadId: string;
  onSaved: () => void;
}) {
  const [model, setModel] = useState(models[0] ?? "");
  const [msgs, setMsgs] = useState<UiMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [think, setThink] = useState(true);
  const [web, setWeb] = useState(true);
  const [kb, setKb] = useState(false);
  const [kbId, setKbId] = useState<string | undefined>(undefined); // undefined = 全部集合
  const [kbList, setKbList] = useState<{ kbId: string; docs: number; chunks: number }[]>([]);
  const [kbMenuOpen, setKbMenuOpen] = useState(false);
  const [paramsOpen, setParamsOpen] = useState(false);
  const [sampling, setSampling] = useState<Sampling>({});
  const [usage, setUsage] = useState<{ promptTokens: number; completionTokens: number; totalTokens: number } | null>(
    null,
  );
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  const [images, setImages] = useState<UiImage[]>([]);
  // 右侧「工件」面板：本会话目录下产出的文件（fs 工具写入 / 命令生成的网页/构建物）。
  const [files, setFiles] = useState<WsEntry[]>([]);
  const [dockOpen, setDockOpen] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const autoOpenedRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // 卸载（切换会话会因 key 重挂载）时中断在途的 agent 流。
  useEffect(() => () => abortRef.current?.abort(), []);

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
      const base64 = dataUrl.replace(/^data:[^;]+;base64,/, "");
      next.push({ mimeType: f.type, data: base64 });
    }
    if (next.length) setImages((cur) => [...cur, ...next]);
  };

  if (model === "" && models.length > 0) setModel(models[0]!);

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
      setMsgs([
        { role: "user", raw: "/api/export 在大工作区会 504。改成流式 NDJSON + 游标分页，保留 CSV 下载。", reasoning: "", tools: [], at: Date.now() },
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
                name: "web_search",
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
        setMsgs(storedToUiMsgs(list as unknown as StoredMsg[]));
        // 回填该会话最后一轮的上下文用量 → 打开历史长会话即显示进度环（实测 token，含 system/记忆/工具开销）。
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

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [msgs]);

  // 切换模型 → 载入该模型的采样覆盖。
  useEffect(() => {
    setSampling(loadSampling(model));
  }, [model]);

  // 开启知识库时拉取可用集合。
  useEffect(() => {
    if (!kb) return;
    void getClient()
      .kbList()
      .then((r) => setKbList(r.kbs))
      .catch(() => setKbList([]));
  }, [kb]);

  const setParam = (key: keyof Sampling, raw: string) => {
    const v = raw.trim() === "" ? undefined : Number(raw);
    const next = { ...sampling };
    if (v === undefined || Number.isNaN(v)) delete next[key];
    else next[key] = v;
    setSampling(next);
    saveSampling(model, next);
  };

  const autoGrow = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
    el.style.overflowY = el.scrollHeight > 160 ? "auto" : "hidden";
  };

  const send = async () => {
    const text = input.trim();
    if ((!text && images.length === 0) || !model || busy) return;
    const sentImages = images;
    setInput("");
    setImages([]);
    if (taRef.current) taRef.current.style.height = "24px";
    setBusy(true);
    const history: ChatMessage[] = msgs.map((m) => ({
      role: m.role,
      content: m.role === "assistant" ? splitThink(m.raw).answer : m.raw,
    }));
    // 含图片时用多模态 content parts（走 mmproj 视觉模型）。
    const userContent: ChatMessage["content"] =
      sentImages.length > 0
        ? [
            ...(text ? [{ type: "text" as const, text }] : []),
            ...sentImages.map((im) => ({ type: "image" as const, mimeType: im.mimeType, data: im.data })),
          ]
        : text;
    history.push({ role: "user", content: userContent });
    setMsgs((m) => [
      ...m,
      { role: "user", raw: text, reasoning: "", tools: [], at: Date.now(), ...(sentImages.length ? { images: sentImages } : {}) },
      { role: "assistant", raw: "", reasoning: "", tools: [] },
    ]);

    const apply = (fn: (m: UiMsg) => UiMsg) =>
      setMsgs((cur) => {
        const next = cur.slice();
        next[next.length - 1] = fn(next[next.length - 1]!);
        return next;
      });

    const excludeTools = web ? [] : ["web_search", "http_get"];
    const sampling = samplingToRequest(loadSampling(model));
    const agentPrefs = loadAgentPrefs();
    const excludeSkills = loadDisabledSkills();
    const ac = new AbortController();
    abortRef.current = ac;
    const FS_TOOLS = new Set(["fs_write", "fs_edit", "run_command"]);
    try {
      for await (const ev of getClient().runAgent(
        {
          threadId,
          model,
          history,
          excludeTools,
          think,
          kb,
          ...(kb && kbId ? { kbId } : {}),
          ...(Object.keys(sampling).length ? { sampling } : {}),
          ...(agentPrefs.maxIterations ? { maxIterations: agentPrefs.maxIterations } : {}),
          ...(excludeSkills.length ? { excludeSkills } : {}),
        },
        { signal: ac.signal },
      )) {
        if (ev.type === "usage") setUsage(ev.usage);
        else if (ev.type === "approval-request")
          setApproval({ id: ev.id, toolName: ev.toolName, args: ev.args });
        else if (ev.type === "final") apply((m) => (m.raw ? m : { ...m, raw: messageText(ev.message.content) }));
        else if (ev.type === "error") apply((m) => ({ ...m, raw: `${m.raw}\n\n[错误] ${ev.message}` }));
        else if (ev.type === "tool-end") {
          apply((m) => applyAgentEvent(m, ev));
          if (FS_TOOLS.has(ev.call.name)) void refreshFiles(); // 文件类工具完成即刷新工件面板
        } else apply((m) => applyAgentEvent(m, ev));
      }
      onSaved();
      void refreshFiles();
    } catch (e) {
      if (!ac.signal.aborted)
        apply((m) => ({ ...m, raw: `${m.raw}\n\n[请求失败] ${e instanceof Error ? e.message : String(e)}` }));
    } finally {
      setBusy(false);
    }
  };

  // 取消输出：中止在途请求（→ SSE 断开 → 后端回滚 pi 上下文、整轮不落库），并标记本条为已取消。
  const stop = () => {
    abortRef.current?.abort();
    setApproval(null);
    setMsgs((cur) => {
      const next = cur.slice();
      const last = next[next.length - 1];
      if (last && last.role === "assistant") next[next.length - 1] = { ...last, cancelled: true };
      return next;
    });
  };

  const respondApproval = async (verdict: "approve" | "approve-always" | "deny") => {
    if (!approval) return;
    const id = approval.id;
    setApproval(null);
    try {
      await getClient().approveTool(id, verdict);
    } catch {
      /* 忽略：流可能已结束 */
    }
  };

  return (
    <div className="chat-wrap">
      <div className="chat">
      <header className="bar">
        <span className={`mdot ${model ? "on" : ""}`} />
        <select className="model-select" value={model} onChange={(e) => setModel(e.target.value)}>
          {models.length === 0 && <option value="">（无可用模型，请先在“模型”页加载或配置）</option>}
          {models.map((m) => (
            <option key={m} value={m}>
              {modelLabel(m)}
            </option>
          ))}
        </select>
        <div className="params-wrap">
          <button
            className={`params-btn ${Object.keys(sampling).length ? "on" : ""}`}
            onClick={() => setParamsOpen((v) => !v)}
            disabled={!model}
            title="生成参数（按当前模型）"
          >
            <SlidersIcon size={16} />
          </button>
          {paramsOpen && (
            <>
              <div className="menu-backdrop" onClick={() => setParamsOpen(false)} />
              <div className="params-pop">
                <div className="pp-head">
                  <span>生成参数 · {modelLabel(model)}</span>
                  <button
                    className="pp-reset"
                    onClick={() => {
                      setSampling({});
                      saveSampling(model, {});
                    }}
                  >
                    重置
                  </button>
                </div>
                {(
                  [
                    ["temperature", "温度", "0.7", "0.05"],
                    ["topP", "top_p", "0.9", "0.05"],
                    ["topK", "top_k", "40", "1"],
                    ["minP", "min_p", "0", "0.01"],
                    ["repeatPenalty", "重复惩罚", "1.0", "0.05"],
                    ["maxTokens", "max_tokens", "无上限", "64"],
                  ] as const
                ).map(([key, label, ph, step]) => (
                  <label key={key} className="pp-row">
                    <span>{label}</span>
                    <input
                      type="number"
                      step={step}
                      placeholder={`默认 ${ph}`}
                      value={sampling[key] ?? ""}
                      onChange={(e) => setParam(key, e.target.value)}
                    />
                  </label>
                ))}
                <div className="pp-note">仅对「{modelLabel(model)}」生效，自动保存。</div>
              </div>
            </>
          )}
        </div>
        <span className="bar-spacer" />
        {usage && (
          <span className="usage" title="本轮 token 用量">
            ↑{usage.promptTokens} ↓{usage.completionTokens}
          </span>
        )}
        <button
          className={`ws-review-toggle ${dockOpen ? "on" : ""}`}
          onClick={() => setDockOpen((v) => !v)}
          title="工作台：文件 / 终端 / 预览"
        >
          <FileCodeIcon size={14} /> 工作台
          {files.length > 0 && <span className="rev-count">{files.length}</span>}
        </button>
      </header>
      <div className="messages" ref={scrollRef}>
        {msgs.length === 0 && (
          <div className="greeting">
            <span className="greet-spark">
              <SparkIcon size={30} />
            </span>
            <h1>有什么可以帮你？</h1>
            <p className="greet-sub">
              本地或云端模型、工具调用、Skills/MCP，带记忆。
              {!model && "先到「模型」页加载模型或在「设置」配置 provider。"}
            </p>
            <div className="greet-pills">
              {STARTERS.map(({ label, prompt, Icon }) => (
                <button
                  key={label}
                  className="greet-pill"
                  onClick={() => {
                    setInput(prompt);
                    requestAnimationFrame(() => {
                      const ta = taRef.current;
                      if (ta) {
                        ta.focus();
                        ta.setSelectionRange(prompt.length, prompt.length);
                        autoGrow(ta);
                      }
                    });
                  }}
                >
                  <Icon size={14} />
                  {label}
                </button>
              ))}
            </div>
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
          <textarea
            ref={taRef}
            value={input}
            rows={1}
            placeholder="发送消息…"
            onChange={(e) => {
              setInput(e.target.value);
              autoGrow(e.target);
            }}
            onKeyDown={(e) => {
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
            <button className={`chip ${think ? "on" : ""}`} onClick={() => setThink((v) => !v)} title="思维链（Qwen3 等）">
              <ThinkIcon size={15} /> 思考
            </button>
            <button className={`chip ${web ? "on" : ""}`} onClick={() => setWeb((v) => !v)} title="联网（需配置 web 工具/MCP）">
              <GlobeIcon size={15} /> 联网
            </button>
            <div className="kb-wrap">
              <button
                className={`chip kb-chip ${kb ? "on" : ""}`}
                onClick={() => setKb((v) => !v)}
                title="知识库 RAG 开关（检索已上传文档并注入引用）"
              >
                <BoxIcon size={15} /> 知识库{kb ? (kbId ? `·${kbId}` : "·全部") : ""}
              </button>
              <button
                className={`chip kb-caret ${kb ? "on" : ""}`}
                onClick={() => setKbMenuOpen((v) => !v)}
                title="选择知识库集合"
              >
                <ChevronIcon size={13} />
              </button>
              {kbMenuOpen && (
                <>
                  <div className="menu-backdrop" onClick={() => setKbMenuOpen(false)} />
                  <div className="kb-menu">
                    <button
                      className={!kbId ? "active" : ""}
                      onClick={() => {
                        setKbId(undefined);
                        setKb(true);
                        setKbMenuOpen(false);
                      }}
                    >
                      全部知识库
                    </button>
                    {kbList.map((k) => (
                      <button
                        key={k.kbId}
                        className={kbId === k.kbId ? "active" : ""}
                        onClick={() => {
                          setKbId(k.kbId);
                          setKb(true);
                          setKbMenuOpen(false);
                        }}
                      >
                        {k.kbId} <small>{k.docs} 文档</small>
                      </button>
                    ))}
                    {kbList.length === 0 && <div className="kb-empty">暂无知识库，去「设置」上传</div>}
                  </div>
                </>
              )}
            </div>
            <span className="cspacer" />
            {contexts[model] ? (
              <ContextRing pct={usage ? (usage.promptTokens / contexts[model]!) * 100 : 0} />
            ) : null}
            <button className="cbtn" title="语音（即将支持）" disabled>
              <MicIcon size={18} />
            </button>
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
        <div className="composer-note">本地 AI 也可能出错，请自行核实重要信息。</div>
      </footer>
      </div>
      <SideDock
        open={dockOpen}
        onClose={() => setDockOpen(false)}
        files={files}
        readFile={(p) => getClient().chatFile(threadId, p)}
        onFilesRefresh={() => void refreshFiles()}
        onRevealDir={() => void getClient().chatReveal(threadId)}
        filesEmpty="本会话还没有产出文件。让 AI 写文件、或运行命令生成网页 / 构建物后，会在这里展示并可预览。"
        msgs={msgs}
        exec={(c) => getClient().chatExec(threadId, c)}
        previewUrl={previewUrl}
        onClearPreview={() => setPreviewUrl(null)}
      />
    </div>
  );
}
