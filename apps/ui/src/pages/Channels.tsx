import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChannelAdapterMeta, ChannelConfig, ChannelStatus } from "@ew/shared";
import { getClient } from "../lib/client.js";
import { useConfirm } from "../components/ConfirmDialog.js";
import { PlusIcon, PlayIcon, StopIcon, TrashIcon, GearIcon } from "../icons.js";

function kindLabel(kind: string, adapters: ChannelAdapterMeta[]): string {
  return adapters.find((k) => k.kind === kind)?.label ?? kind;
}

function blankConfig(kinds: ChannelAdapterMeta[]): ChannelConfig | null {
  const first = kinds[0];
  if (!first) return null;
  return {
    id: `${first.kind}-${crypto.randomUUID().slice(0, 8)}`,
    kind: first.kind,
    enabled: false,
    displayName: "",
    secrets: {},
    options: {},
    auth: { allowAll: true },
  };
}

function joinList(items?: string[]): string {
  return items?.join(", ") ?? "";
}

function splitList(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function Channels() {
  const [adapters, setAdapters] = useState<ChannelAdapterMeta[]>([]);
  const [connectors, setConnectors] = useState<ChannelConfig[]>([]);
  const [statuses, setStatuses] = useState<ChannelStatus[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<ChannelConfig | null>(null);
  const [note, setNote] = useState("");
  const { confirm: askConfirm, dialog: confirmDialog } = useConfirm();

  const statusById = useMemo(() => {
    const map = new Map<string, ChannelStatus>();
    for (const s of statuses) map.set(s.id, s);
    return map;
  }, [statuses]);
  const editingMeta = useMemo(() => (editing ? adapters.find((a) => a.kind === editing.kind) : undefined), [adapters, editing]);

  const refresh = useCallback(async () => {
    try {
      const [meta, list, stat] = await Promise.all([
        getClient().listChannelAdapters(),
        getClient().listChannelConnectors(),
        getClient().listChannelStatuses(),
      ]);
      setAdapters(meta);
      setConnectors(list);
      setStatuses(stat);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const startAdd = () => {
    const next = blankConfig(adapters);
    if (!next) {
      setNote("没有可用的渠道 adapter");
      return;
    }
    setEditing(next);
    setNote("");
  };

  const save = async () => {
    if (!editing) return;
    setBusy(editing.id);
    setNote("");
    try {
      const next = await getClient().upsertChannelConnector(editing);
      setNote(next.running ? "已保存并启动" : "已保存");
      await refresh();
      setEditing(null);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (c: ChannelConfig, s?: ChannelStatus) => {
    setBusy(c.id);
    try {
      if (s?.running) await getClient().stopChannelConnector(c.id);
      else await getClient().startChannelConnector(c.id);
      await refresh();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (c: ChannelConfig) => {
    if (!(await askConfirm({ title: `删除渠道「${c.displayName || c.id}」？`, body: "该渠道配置会从本机移除。", danger: true }))) return;
    setBusy(c.id);
    try {
      await getClient().removeChannelConnector(c.id);
      if (editing?.id === c.id) setEditing(null);
      await refresh();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const patchEditing = (patch: Partial<ChannelConfig>) => {
    setEditing((cur) => (cur ? { ...cur, ...patch } : cur));
  };

  return (
    <div className="page channels-page" data-testid="channels-page">
      <div className="skills-head">
        <p className="skills-lead">外部渠道经过 Channel Gateway 统一进同一个大脑；这里管理连接器配置、启停与授权范围。</p>
        <span className="bar-spacer" />
        <button className="set-btn secondary icon" title="新建渠道" onClick={startAdd} disabled={adapters.length === 0}>
          <PlusIcon size={16} />
        </button>
      </div>

      {note && <div className="note" data-testid="channels-note">{note}</div>}

      {editing && (
        <div className="set-group" data-testid="channels-editor">
          <div className="set-row">
            <div className="set-row-info">
              <div className="set-row-title">基础信息</div>
              <div className="set-row-desc">先保存一个最小可用配置；不同平台的 secret / 选项后续在 adapter 详情里补。</div>
            </div>
          </div>
          <div className="set-row col">
            <input
              data-testid="channels-form-id"
              value={editing.id}
              disabled
              readOnly
              placeholder="渠道 id"
            />
            <input
              data-testid="channels-form-name"
              value={editing.displayName ?? ""}
              onChange={(e) => setEditing({ ...editing, displayName: e.target.value })}
              placeholder="显示名称"
            />
            <div className="seg" data-testid="channels-kind-switch">
              {adapters.map((k) => (
                <button
                  key={k.kind}
                  className={editing.kind === k.kind ? "on" : ""}
                  onClick={() => patchEditing({ kind: k.kind })}
                >
                  {k.label}
                </button>
              ))}
            </div>
          </div>
          <div className="set-row">
            <div className="set-row-info">
              <div className="set-row-title">自动启动</div>
              <div className="set-row-desc">保存后立即启动连接器；关闭则仅保存配置。</div>
            </div>
            <div className="set-row-control">
              <button
                className={`set-toggle ${editing.enabled ? "on" : ""}`}
                data-testid="channels-enabled-toggle"
                onClick={() => patchEditing({ enabled: !editing.enabled })}
              >
                <span />
              </button>
            </div>
          </div>
          <div className="set-row col">
            <div className="set-row-title">必需密钥</div>
            <div className="set-row-desc">按平台要求填写。Telegram 目前需要 Bot Token。</div>
            <div className="channels-secret-grid">
              {(editingMeta?.requiredSecrets.length ? editingMeta.requiredSecrets : [{ key: "token", label: "Bot Token", password: true }]).map((s) => (
                <input
                  key={s.key}
                  data-testid={`channels-secret-${s.key}`}
                  type={s.password ? "password" : "text"}
                  placeholder={s.label}
                  value={String(editing.secrets[s.key] ?? "")}
                  onChange={(e) => patchEditing({ secrets: { ...editing.secrets, [s.key]: e.target.value } })}
                />
              ))}
            </div>
          </div>
          {editing.kind === "telegram" && (
            <div className="set-row col">
              <div className="set-row-title">Telegram 选项</div>
              <div className="set-row-desc">可指定 Bot API baseUrl 和长轮询超时。</div>
              <div className="channels-secret-grid">
                <input
                  data-testid="channels-telegram-base-url"
                  placeholder="baseUrl（默认 https://api.telegram.org）"
                  value={String(editing.options.baseUrl ?? "")}
                  onChange={(e) => patchEditing({ options: { ...editing.options, baseUrl: e.target.value } })}
                />
                <input
                  data-testid="channels-telegram-poll-timeout"
                  placeholder="pollTimeout（秒）"
                  inputMode="numeric"
                  value={String(editing.options.pollTimeout ?? "")}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    patchEditing({ options: { ...editing.options, pollTimeout: Number.isFinite(n) ? n : undefined } });
                  }}
                />
              </div>
            </div>
          )}
          <div className="set-row col">
            <div className="set-row-title">授权范围</div>
            <div className="set-row-control">
              <button
                className={`set-btn small ${editing.auth?.allowAll ? "primary" : "secondary"}`}
                onClick={() => patchEditing({ auth: { ...editing.auth, allowAll: true, allowedChats: [], allowedUsers: [] } })}
              >
                全部允许
              </button>
              <button
                className={`set-btn small ${!editing.auth?.allowAll ? "primary" : "secondary"}`}
                onClick={() => patchEditing({ auth: { ...editing.auth, allowAll: false } })}
              >
                限定列表
              </button>
            </div>
            <div className="set-row-desc">列表模式下可继续填写 allowedUsers / allowedChats（当前先保留在 JSON 里由后端消费）。</div>
          </div>
          <div className="set-row col">
            <div className="set-row-title">允许用户</div>
            <input
              data-testid="channels-allowed-users"
              placeholder="逗号分隔的 channelUserId 列表"
              value={joinList(editing.auth?.allowedUsers)}
              onChange={(e) => patchEditing({ auth: { ...editing.auth, allowedUsers: splitList(e.target.value) } })}
            />
          </div>
          <div className="set-row col">
            <div className="set-row-title">允许会话</div>
            <input
              data-testid="channels-allowed-chats"
              placeholder="逗号分隔的 channelChatId 列表"
              value={joinList(editing.auth?.allowedChats)}
              onChange={(e) => patchEditing({ auth: { ...editing.auth, allowedChats: splitList(e.target.value) } })}
            />
          </div>
          <div className="set-row">
            <div className="set-row-control">
              <button className="set-btn ghost soft" onClick={() => setEditing(null)}>
                取消
              </button>
              <button className="set-btn primary" onClick={() => void save()} disabled={busy === editing.id}>
                {editing.enabled ? "保存并启动" : "保存"}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="mcp-list" data-testid="channels-list">
        {connectors.length === 0 ? (
          <div className="empty-models">
            <div className="ring">
              <GearIcon size={22} />
            </div>
            <h2>还没有渠道</h2>
            <p>先新建一个连接器，外部消息就能进到同一个会话系统里。</p>
          </div>
        ) : (
          connectors.map((c) => {
            const s = statusById.get(c.id);
            const meta = adapters.find((a) => a.kind === c.kind);
            const running = s?.running ?? false;
            return (
              <div className="mcp-card" key={c.id} data-testid={`channels-card-${c.id}`}>
                <div className={`mcp-dot ${running ? "ok" : ""}`} />
              <div className="mcp-card-body">
                <div className="mcp-card-name">
                  <span>{c.displayName || c.id}</span>
                  <span className="set-pill">{kindLabel(c.kind, adapters)}</span>
                  {running ? <span className="set-pill">运行中</span> : <span className="set-pill ghost">已停止</span>}
                  {meta?.supportsWebhook ? <span className="set-pill">Webhook</span> : <span className="set-pill ghost">Long-poll</span>}
                </div>
                  <div className="mcp-card-detail">
                    {meta?.label ?? c.kind}
                    {c.auth?.allowAll ? " · 全部允许" : " · 限定范围"}
                    {s?.lastError ? ` · ${s.lastError}` : ""}
                  </div>
                </div>
                <button className="mcp-icon-btn" title={running ? "停止" : "启动"} onClick={() => void toggle(c, s)} disabled={busy === c.id}>
                  {running ? <StopIcon size={16} /> : <PlayIcon size={16} />}
                </button>
                <button className="mcp-icon-btn" title="编辑" onClick={() => setEditing(c)} disabled={busy === c.id}>
                  <GearIcon size={16} />
                </button>
                <button className="mcp-icon-btn danger" title="删除" onClick={() => void remove(c)} disabled={busy === c.id}>
                  <TrashIcon size={16} />
                </button>
              </div>
            );
          })
        )}
      </div>

      {confirmDialog}
    </div>
  );
}
