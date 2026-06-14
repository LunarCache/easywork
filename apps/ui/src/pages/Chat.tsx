import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { ChatMessage } from "@ew/shared";
import { getClient } from "../lib/client.js";
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
  type Sampling,
} from "../lib/prefs.js";
import {
  ArrowUpIcon,
  BoxIcon,
  BrainIcon,
  ChatIcon,
  CheckIcon,
  ChevronIcon,
  CodeIcon,
  CopyIcon,
  GlobeIcon,
  MicIcon,
  PlusBtnIcon,
  SlidersIcon,
  ThinkIcon,
  WrenchIcon,
} from "../icons.js";

function fmtK(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function host(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function toolQuery(args: string): string {
  try {
    const a = JSON.parse(args || "{}") as { query?: string; url?: string };
    return a.query || a.url || "";
  } catch {
    return "";
  }
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="msg-action"
      title="复制"
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    >
      {done ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
    </button>
  );
}

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
  const [think, setThink] = useState(false);
  const [web, setWeb] = useState(false);
  const [code, setCode] = useState(false);
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // 卸载（切换会话会因 key 重挂载）时中断在途的 agent 流。
  useEffect(() => () => abortRef.current?.abort(), []);

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
      setMsgs([
        { role: "user", raw: "北京现在几点？顺便算一下 (3+4)*2", reasoning: "", tools: [] },
        {
          role: "assistant",
          raw: "<think>先取时间，再用计算器。</think>已经查到了 👇\n\n现在北京时间约为 **14:32**，`(3+4)*2 = 14`。\n\n### 用到的工具\n1. **get_time** — 取时间\n2. **calculator** — 计算\n\n```python\nresult = (3 + 4) * 2  # = 14\n```",
          reasoning: "",
          tools: [
            {
              id: "0",
              name: "web_search",
              args: '{"query":"Unsloth Studio 是什么"}',
              result: "...",
              status: "done",
              sources: [
                { title: "Introducing Unsloth Studio | Unsloth Documentation", url: "https://unsloth.ai/docs/new/studio" },
                { title: "GitHub - unslothai/unsloth", url: "https://github.com/unslothai/unsloth" },
                { title: "How to Run Unsloth Studio Locally", url: "https://www.datacamp.com/tutorial/unsloth-studio" },
              ],
            },
            { id: "1", name: "get_time", args: '{"timezone":"Asia/Shanghai"}', result: "2026-06-13 14:32:10", status: "done" },
            { id: "2", name: "calculator", args: '{"expression":"(3+4)*2"}', result: "14", status: "done" },
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
      { role: "user", raw: text, reasoning: "", tools: [], ...(sentImages.length ? { images: sentImages } : {}) },
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
    const ac = new AbortController();
    abortRef.current = ac;
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
        },
        { signal: ac.signal },
      )) {
        if (ev.type === "usage") setUsage(ev.usage);
        else if (ev.type === "approval-request")
          setApproval({ id: ev.id, toolName: ev.toolName, args: ev.args });
        else if (ev.type === "final") apply((m) => (m.raw ? m : { ...m, raw: messageText(ev.message.content) }));
        else if (ev.type === "error") apply((m) => ({ ...m, raw: `${m.raw}\n\n[错误] ${ev.message}` }));
        else apply((m) => applyAgentEvent(m, ev));
      }
      onSaved();
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
      /* 忽略：流可能已结束 */
    }
  };

  return (
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
        {usage &&
          (contexts[model] ? (
            <div className="ctxbar" title={`上下文用量 ${usage.promptTokens} / ${contexts[model]} tokens`}>
              <span className="ctxnum">
                {fmtK(usage.promptTokens)} / {fmtK(contexts[model]!)}
              </span>
              <div className="ctxtrack">
                <div
                  className="ctxfill"
                  style={{ width: `${Math.min(100, (usage.promptTokens / contexts[model]!) * 100)}%` }}
                />
              </div>
            </div>
          ) : (
            <span className="usage" title="本轮 token 用量">
              ↑{usage.promptTokens} ↓{usage.completionTokens}
            </span>
          ))}
      </header>
      <div className="messages" ref={scrollRef}>
        {msgs.length === 0 && (
          <div className="empty">
            <div className="ring">
              <ChatIcon size={28} />
            </div>
            <h2>开始对话</h2>
            <p>本地或云端模型、工具调用、Skills/MCP、带记忆。{!model && "先到「模型」页加载模型或在「设置」配置 provider。"}</p>
          </div>
        )}
        {msgs.map((m, i) => {
          if (m.role === "user")
            return (
              <div key={i} className="msg user">
                <div className="role">你</div>
                {m.images && m.images.length > 0 && (
                  <div className="msg-images">
                    {m.images.map((im, j) => (
                      <img key={j} src={`data:${im.mimeType};base64,${im.data}`} alt="" />
                    ))}
                  </div>
                )}
                {m.raw && <div className="text">{m.raw}</div>}
              </div>
            );
          const { reasoning: thinkReason, answer } = splitThink(m.raw);
          const reasoning = `${m.reasoning}\n${thinkReason}`.trim();
          const isLast = i === msgs.length - 1;
          const thinking = busy && isLast && !answer;
          return (
            <div key={i} className="msg assistant">
              <div className="role">助手</div>
              {reasoning &&
                (() => {
                  const dur = m.start && m.thinkEnd ? (m.thinkEnd - m.start) / 1000 : null;
                  const label = thinking
                    ? "思考中…"
                    : dur != null
                      ? `思考了 ${dur < 1 ? "<1" : Math.round(dur)} 秒`
                      : "思考过程";
                  return (
                    <details className="reason" open={thinking}>
                      <summary>
                        <BrainIcon size={15} />
                        <span>{label}</span>
                        <ChevronIcon size={14} className="chev" />
                      </summary>
                      <div className="reason-body">{reasoning}</div>
                    </details>
                  );
                })()}
              {m.tools.map((t) =>
                t.name === "web_search" ? (
                  <div key={t.id} className="toolsearch">
                    <div className="ts-head">
                      <GlobeIcon size={15} />
                      <span>
                        {t.status === "running" ? "正在搜索" : "已搜索"}
                        {toolQuery(t.args) && ` “${toolQuery(t.args)}”`}
                      </span>
                    </div>
                    {t.sources && t.sources.length > 0 && (
                      <div className="ts-chips">
                        {t.sources.map((s, j) => (
                          <a key={j} className="src-chip" href={s.url} target="_blank" rel="noreferrer" title={s.url}>
                            <img
                              src={`https://www.google.com/s2/favicons?domain=${host(s.url)}&sz=64`}
                              alt=""
                              onError={(e) => (e.currentTarget.style.visibility = "hidden")}
                            />
                            <span>{s.title || host(s.url)}</span>
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                <div key={t.id}>
                  <details className={`toolcard ${t.status}`}>
                    <summary>
                      <WrenchIcon size={15} className="ticon" />
                      <span className="tname">{t.name}</span>
                      <span className="tlabel">
                        {t.status === "running" ? "调用中…" : t.status === "error" ? "失败" : "完成"}
                      </span>
                      <ChevronIcon size={14} className="chev" />
                    </summary>
                    <div className="toolbody">
                      <div className="tkv">
                        <span>参数</span>
                        <code>{t.args || "{}"}</code>
                      </div>
                      {t.result != null && (
                        <div className="tkv">
                          <span>结果</span>
                          <code>{t.result}</code>
                        </div>
                      )}
                    </div>
                  </details>
                  {t.citations && t.citations.length > 0 && (
                    <div className="citations">
                      <div className="cite-head">引用来源</div>
                      <div className="cite-list">
                        {t.citations.map((c) => (
                          <span key={c.id} className="cite-chip" title={c.source}>
                            <b>[{c.id}]</b> {c.source}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  {t.html && (
                    <div className="artifact">
                      <div className="artifact-head">
                        <CodeIcon size={13} /> {t.htmlTitle || "HTML 工件"}
                      </div>
                      <iframe
                        className="artifact-frame"
                        sandbox="allow-scripts"
                        title={t.htmlTitle || "artifact"}
                        srcDoc={t.html}
                      />
                    </div>
                  )}
                </div>
                ),
              )}
              {answer ? (
                <div className="text md">
                  <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                    {answer}
                  </Markdown>
                  {busy && isLast && <span className="cursor" />}
                  {!(busy && isLast) && <CopyButton text={answer} />}
                </div>
              ) : (
                busy && isLast && m.tools.length === 0 && <div className="text">正在思考…</div>
              )}
            </div>
          );
        })}
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
                  <button onClick={() => setImages((cur) => cur.filter((_, k) => k !== j))}>×</button>
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
            <button className={`chip ${code ? "on" : ""}`} onClick={() => setCode((v) => !v)} title="代码执行（默认关）">
              <CodeIcon size={15} /> 代码
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
            <button className="cbtn" title="语音（即将支持）" disabled>
              <MicIcon size={18} />
            </button>
            <button className="csend" onClick={() => void send()} disabled={busy || !model} title="发送">
              <ArrowUpIcon size={18} />
            </button>
          </div>
        </div>
        <div className="composer-note">本地 AI 也可能出错，请自行核实重要信息。</div>
      </footer>
    </div>
  );
}
