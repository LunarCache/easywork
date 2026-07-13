import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import type { ChannelStatus, StoredMessage } from "@ew/shared";
import type { InboxThread } from "@ew/sdk";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { getClient } from "../lib/client.js";
import { messageText } from "../lib/agent-stream.js";
import {
  ChatIcon,
  ClockIcon,
  GearIcon,
  InboxIcon,
  PanelRightIcon,
  RefreshIcon,
  SearchIcon,
  ShieldIcon,
  StopIcon,
  UserIcon,
  XIcon,
} from "../icons.js";

type InboxFilter = "all" | "running" | "stopped";

const INBOX_LIST_W_KEY = "ew.inboxListWidth";
const INBOX_LIST_MIN = 220;
const INBOX_LIST_MAX = 380;
const INBOX_LIST_DEFAULT = 280;

function loadInboxListWidth(): number {
  try {
    const n = Number(localStorage.getItem(INBOX_LIST_W_KEY));
    return Number.isFinite(n) && n >= INBOX_LIST_MIN && n <= INBOX_LIST_MAX ? n : INBOX_LIST_DEFAULT;
  } catch {
    return INBOX_LIST_DEFAULT;
  }
}

const CHANNEL_META: Record<string, { label: string; short: string }> = {
  telegram: { label: "Telegram", short: "TG" },
  feishu: { label: "飞书", short: "飞" },
  wechat: { label: "微信", short: "微" },
  wecom: { label: "企业微信", short: "企" },
  discord: { label: "Discord", short: "DC" },
  inapp: { label: "应用内", short: "EW" },
};

function channelMeta(kind: string): { label: string; short: string } {
  return CHANNEL_META[kind] ?? { label: kind, short: kind.slice(0, 2).toUpperCase() };
}

function rawThreadName(thread: InboxThread): string {
  const prefix = `${thread.channel.kind}:`;
  const title = thread.title.trim();
  return title.startsWith(prefix) ? title.slice(prefix.length) : title;
}

function looksOpaqueId(value: string, channelId: string): boolean {
  const text = value.trim();
  if (!text) return true;
  if (text === channelId) return true;
  if (text.includes("@im.")) return true;
  if (/^(wxid_|ou_|oc_|on_|chat_|tg_|dc_)/i.test(text)) return true;
  if (/^[a-z0-9_-]{18,}$/i.test(text)) return true;
  return false;
}

function displayTitle(thread: InboxThread): string {
  const raw = rawThreadName(thread);
  if (raw && !looksOpaqueId(raw, thread.channel.channelId)) return raw;
  const meta = channelMeta(thread.channel.kind);
  return `${meta.label}${thread.channel.kind === "wechat" || thread.channel.kind === "telegram" ? "联系人" : "会话"}`;
}

function displaySubtitle(thread: InboxThread): string {
  const meta = channelMeta(thread.channel.kind);
  return `${meta.label} · ${compactId(thread.channel.channelId)}`;
}

function compactId(id: string): string {
  if (id.length <= 18) return id;
  return `${id.slice(0, 8)}…${id.slice(-6)}`;
}

function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function fullTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(t);
}

function threadPreview(thread: InboxThread): string {
  const text = thread.lastMessage?.text.trim();
  if (text) return cleanPreview(text);
  return "暂无消息";
}

function cleanPreview(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " 代码片段 ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function isThreadRunning(thread: InboxThread, statuses: ChannelStatus[]): boolean {
  return statuses.some((status) => status.kind === thread.channel.kind && status.running);
}

function filterMatches(thread: InboxThread, filter: InboxFilter, statuses: ChannelStatus[]): boolean {
  if (filter === "all") return true;
  const running = isThreadRunning(thread, statuses);
  return filter === "running" ? running : !running;
}

function statusLabel(status: ChannelStatus): string {
  if (status.lastError) return "异常";
  if (status.running) return "运行中";
  if (status.enabled) return "已停止";
  return "未启用";
}

function statusSummary(statuses: ChannelStatus[], selectedRunning: boolean): string {
  if (selectedRunning) return "连接器正在接收并自动回复消息";
  if (statuses.some((status) => status.enabled)) return "已配置连接器，但当前未运行";
  if (statuses.length) return "连接器未启用";
  return "没有同类连接器状态";
}

function liveLabel(statuses: ChannelStatus[], selectedRunning: boolean): string {
  if (selectedRunning) return "自动回复中";
  if (statuses.some((status) => status.enabled)) return "已停止";
  if (statuses.length) return "未启用";
  return "未配置";
}

interface TimelineMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  imageCount: number;
  createdAt: string;
}

function toTimeline(messages: StoredMessage[]): TimelineMessage[] {
  return messages
    .filter(
      (message): message is StoredMessage & { role: "user" | "assistant" } =>
        message.role === "user" || message.role === "assistant",
    )
    .map((message) => ({
      id: message.id,
      role: message.role,
      text: messageText(message.parts).trim(),
      imageCount: message.parts.filter((part) => part.type === "image" && "data" in part && part.data).length,
      createdAt: message.createdAt,
    }))
    .filter((message) => message.text || message.imageCount > 0);
}

export function Inbox({
  initialThreadId,
  onThreadsChanged,
  onOpenChannelSettings,
}: {
  initialThreadId?: string | null;
  onThreadsChanged?: () => void;
  onOpenChannelSettings?: () => void;
}) {
  const [threads, setThreads] = useState<InboxThread[]>([]);
  const [statuses, setStatuses] = useState<ChannelStatus[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(initialThreadId ?? null);
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [loading, setLoading] = useState(true);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listWidth, setListWidth] = useState<number>(loadInboxListWidth);
  const [detailOpen, setDetailOpen] = useState(false);
  const selectedIdRef = useRef<string | null>(null);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    if (initialThreadId) setSelectedId(initialThreadId);
  }, [initialThreadId]);

  const loadInbox = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) {
      setLoading(true);
      setError(null);
    }
    try {
      const [nextThreads, nextStatuses] = await Promise.all([
        getClient().listInboxThreads(),
        getClient().listChannelStatuses(),
      ]);
      setThreads(nextThreads);
      setStatuses(nextStatuses);
      setSelectedId((current) => {
        if (current && nextThreads.some((thread) => thread.id === current)) return current;
        return nextThreads[0]?.id ?? null;
      });
      onThreadsChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  }, [onThreadsChanged]);

  const loadMessages = useCallback(async (threadId: string, opts?: { silent?: boolean }) => {
    if (!opts?.silent) setMessagesLoading(true);
    try {
      const next = await getClient().threadMessages(threadId);
      if (selectedIdRef.current === threadId) setMessages(next);
    } catch (e) {
      if (selectedIdRef.current === threadId) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!opts?.silent && selectedIdRef.current === threadId) setMessagesLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadInbox();
  }, [loadInbox]);

  useEffect(() => {
    if (!selectedId) {
      setMessages([]);
      return;
    }
    void loadMessages(selectedId);
  }, [selectedId, loadMessages]);

  const filteredThreads = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return threads.filter((thread) => {
      if (!filterMatches(thread, filter, statuses)) return false;
      if (!needle) return true;
      return [
        displayTitle(thread),
        thread.channel.channelId,
        channelMeta(thread.channel.kind).label,
        threadPreview(thread),
      ]
        .join("\n")
        .toLowerCase()
        .includes(needle);
    });
  }, [threads, statuses, filter, query]);

  const selected = (selectedId ? filteredThreads.find((thread) => thread.id === selectedId) : null) ?? filteredThreads[0] ?? null;
  const timeline = useMemo(() => toTimeline(messages), [messages]);
  const runningCount = threads.filter((thread) => isThreadRunning(thread, statuses)).length;
  const stoppedCount = threads.length - runningCount;
  const selectedMeta = selected ? channelMeta(selected.channel.kind) : null;
  const selectedStatuses = selected ? statuses.filter((status) => status.kind === selected.channel.kind) : [];
  const selectedRunning = selected ? isThreadRunning(selected, statuses) : false;
  const selectedSummary = statusSummary(selectedStatuses, selectedRunning);
  const selectedLiveLabel = liveLabel(selectedStatuses, selectedRunning);

  useEffect(() => {
    setSelectedId((current) => {
      if (!filteredThreads.length) return null;
      if (current && filteredThreads.some((thread) => thread.id === current)) return current;
      return filteredThreads[0]!.id;
    });
  }, [filteredThreads]);

  useEffect(() => {
    const ac = new AbortController();
    const waitForReconnect = () =>
      new Promise<void>((resolve) => {
        const timer = window.setTimeout(resolve, 1_500);
        ac.signal.addEventListener(
          "abort",
          () => {
            window.clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    void (async () => {
      while (!ac.signal.aborted) {
        try {
          for await (const event of getClient().inboxEvents({ signal: ac.signal })) {
            if (ac.signal.aborted || event.type !== "changed") continue;
            void loadInbox({ silent: true });
            const current = selectedIdRef.current;
            if (event.reason === "message" && current && (!event.threadId || event.threadId === current)) {
              void loadMessages(current, { silent: true });
            }
          }
        } catch {
          /* 断线后轻量重连；内容仍以 read model 为准。 */
        }
        if (!ac.signal.aborted) await waitForReconnect();
      }
    })();
    return () => ac.abort();
  }, [loadInbox, loadMessages]);

  const openSettings = () => {
    if (onOpenChannelSettings) onOpenChannelSettings();
    else window.dispatchEvent(new CustomEvent("ew:open-settings", { detail: "channels" }));
  };

  const onListResizeStart = (e: ReactMouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = listWidth;
    let width = startW;
    const move = (ev: MouseEvent) => {
      width = Math.min(INBOX_LIST_MAX, Math.max(INBOX_LIST_MIN, startW + ev.clientX - startX));
      setListWidth(width);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      try {
        localStorage.setItem(INBOX_LIST_W_KEY, String(width));
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  useEffect(() => {
    if (!detailOpen) return;
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setDetailOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [detailOpen]);

  const pageStyle = { "--inbox-list-width": `${listWidth}px` } as CSSProperties;

  return (
    <div className="inbox-page" data-testid="inbox-page" style={pageStyle}>
      <aside className="inbox-list">
        <div className="inbox-list-head">
          <div>
            <div className="inbox-eyebrow">外部渠道</div>
            <h2>收件箱</h2>
          </div>
          <button className="inbox-icon-btn" title="刷新" onClick={() => void loadInbox()}>
            <RefreshIcon size={16} />
          </button>
        </div>

        <label className="inbox-search">
          <SearchIcon size={15} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索联系人或内容" />
        </label>

        <div className="inbox-tabs" role="tablist" aria-label="收件箱筛选">
          <button className={filter === "all" ? "on" : ""} onClick={() => setFilter("all")}>
            全部 <span>{threads.length}</span>
          </button>
          <button className={filter === "running" ? "on" : ""} onClick={() => setFilter("running")}>
            运行中 <span>{runningCount}</span>
          </button>
          <button className={filter === "stopped" ? "on" : ""} onClick={() => setFilter("stopped")}>
            未运行 <span>{stoppedCount}</span>
          </button>
        </div>

        <div className="inbox-thread-list">
          {loading ? (
            <div className="inbox-empty small">正在加载渠道消息…</div>
          ) : error ? (
            <div className="inbox-empty small err">{error}</div>
          ) : filteredThreads.length === 0 ? (
            <div className="inbox-empty small">
              <InboxIcon size={22} />
              <span>{threads.length ? "没有匹配的渠道会话" : "还没有外部渠道消息"}</span>
            </div>
          ) : (
            filteredThreads.map((thread) => {
              const meta = channelMeta(thread.channel.kind);
              const active = selected?.id === thread.id;
              const running = isThreadRunning(thread, statuses);
              return (
                <button
                  key={thread.id}
                  className={`inbox-thread ${active ? "on" : ""}`}
                  onClick={() => setSelectedId(thread.id)}
                  title={`${displayTitle(thread)} · ${thread.channel.channelId}`}
                >
                  <span className={`inbox-avatar ${thread.channel.kind}`}>{meta.short}</span>
                  <span className="inbox-thread-main">
                    <span className="inbox-thread-row">
                      <strong>{displayTitle(thread)}</strong>
                      <time>{relTime(thread.updatedAt)}</time>
                    </span>
                    <span className="inbox-thread-sub">
                      <span>{displaySubtitle(thread)}</span>
                    </span>
                    <span className="inbox-preview">{threadPreview(thread)}</span>
                  </span>
                  <span className={`inbox-state ${running ? "run" : ""}`} title={running ? "连接器运行中" : "连接器未运行"} />
                </button>
              );
            })
          )}
        </div>
      </aside>

      <div className="inbox-resizer" title="拖动调整收件箱列表宽度" onMouseDown={onListResizeStart}>
        <span />
      </div>

      <main className="inbox-conversation">
        {selected && selectedMeta ? (
          <>
            <header className="inbox-conv-head">
              <div className={`inbox-avatar large ${selected.channel.kind}`}>{selectedMeta.short}</div>
              <div className="inbox-conv-title">
                <div className="inbox-conv-name">{displayTitle(selected)}</div>
                <div className="inbox-conv-meta">
                  <span>{displaySubtitle(selected)}</span>
                  <span>{fullTime(selected.updatedAt)}</span>
                </div>
              </div>
              <div className="inbox-conv-actions">
                <span className={`inbox-live ${selectedRunning ? "on" : ""}`}>
                  <span />
                  {selectedLiveLabel}
                </span>
                <button className="inbox-icon-btn" title="查看详情" onClick={() => setDetailOpen(true)}>
                  <PanelRightIcon size={16} />
                </button>
                <button className="inbox-icon-btn" title="渠道设置" onClick={openSettings}>
                  <GearIcon size={16} />
                </button>
              </div>
            </header>

            <div className="inbox-timeline">
              {messagesLoading ? (
                <div className="inbox-empty">正在加载消息…</div>
              ) : timeline.length === 0 ? (
                <div className="inbox-empty">
                  <ChatIcon size={24} />
                  <span>这个渠道会话还没有可展示的文本消息</span>
                </div>
              ) : (
                timeline.map((message) => (
                  <article key={message.id} className={`inbox-msg ${message.role}`}>
                    <div className="inbox-msg-head">
                      {message.role === "user" ? <UserIcon size={13} /> : <ChatIcon size={13} />}
                      <span>{message.role === "user" ? "外部联系人" : "EasyWork"}</span>
                      <time>{fullTime(message.createdAt)}</time>
                    </div>
                    {message.imageCount > 0 && <div className="inbox-image-note">{message.imageCount} 张图片</div>}
                    {message.text &&
                      (message.role === "assistant" ? (
                        <div className="inbox-msg-bubble md">
                          <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                            {message.text}
                          </Markdown>
                        </div>
                      ) : (
                        <div className="inbox-msg-bubble">{message.text}</div>
                      ))}
                  </article>
                ))
              )}
            </div>

            <footer className="inbox-compose">
              <div className="inbox-readonly-note">
                <ShieldIcon size={15} />
                <span>当前为自动回复历史；手动回复稍后接入。</span>
              </div>
            </footer>
          </>
        ) : (
          <div className="inbox-empty hero app-empty">
            <div className="app-empty-mark">
              <InboxIcon size={24} />
            </div>
            <h2>收件箱</h2>
            <p>连接微信、飞书或 Telegram 后，外部消息会按联系人汇聚到这里。</p>
            <button className="inbox-primary" onClick={openSettings}>
              <GearIcon size={15} />
              打开渠道设置
            </button>
          </div>
        )}
      </main>

      {detailOpen && (
        <>
          <button className="inbox-detail-backdrop" aria-label="关闭详情" onClick={() => setDetailOpen(false)} />
          <aside className="inbox-detail" aria-label="渠道会话详情">
            {selected && selectedMeta ? (
              <>
                <div className="inbox-detail-head">
                  <div className={`inbox-avatar ${selected.channel.kind}`}>{selectedMeta.short}</div>
                  <div>
                    <h3>{displayTitle(selected)}</h3>
                    <p>{selectedSummary}</p>
                  </div>
                  <button className="inbox-icon-btn" title="关闭详情" onClick={() => setDetailOpen(false)}>
                    <XIcon size={15} />
                  </button>
                </div>

                <div className="inbox-detail-section">
                  <div className="inbox-detail-title">
                    <UserIcon size={14} />
                    身份
                  </div>
                  <dl className="inbox-kv">
                    <dt>渠道</dt>
                    <dd>{selectedMeta.label}</dd>
                    <dt>渠道 ID</dt>
                    <dd title={selected.channel.channelId}>{compactId(selected.channel.channelId)}</dd>
                    <dt>线程</dt>
                    <dd title={selected.id}>{compactId(selected.id)}</dd>
                    <dt>模型</dt>
                    <dd>{selected.modelId || "默认模型"}</dd>
                  </dl>
                </div>

                <div className="inbox-detail-section">
                  <div className="inbox-detail-title">
                    <ShieldIcon size={14} />
                    授权与状态
                  </div>
                  <div className="inbox-status-list">
                    {selectedStatuses.length === 0 ? (
                      <span className="inbox-muted">没有同类连接器状态</span>
                    ) : (
                      selectedStatuses.map((status) => (
                        <div key={status.id} className="inbox-status-row">
                          <span className={`inbox-state ${status.running ? "run" : ""}`} />
                          <span>{status.displayName || status.id}</span>
                          <em>{statusLabel(status)}</em>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                <div className="inbox-detail-section">
                  <div className="inbox-detail-title">
                    <ClockIcon size={14} />
                    活动
                  </div>
                  <dl className="inbox-kv">
                    <dt>消息数</dt>
                    <dd>{selected.messageCount}</dd>
                    <dt>最近更新</dt>
                    <dd>{fullTime(selected.updatedAt)}</dd>
                  </dl>
                </div>

                <div className="inbox-actions">
                  <button className="inbox-secondary" disabled title="后续接入自动回复开关">
                    <StopIcon size={15} />
                    暂停自动回复
                  </button>
                  <button className="inbox-secondary" onClick={openSettings}>
                    <GearIcon size={15} />
                    渠道设置
                  </button>
                </div>
              </>
            ) : (
              <div className="inbox-empty small">
                <ShieldIcon size={22} />
                <span>选择一条渠道会话查看连接器状态</span>
              </div>
            )}
          </aside>
        </>
      )}
    </div>
  );
}
