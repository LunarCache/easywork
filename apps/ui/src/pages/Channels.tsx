import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChannelAdapterMeta, ChannelConfig, ChannelStatus } from "@ew/shared";
import type { FeishuRegistrationSession } from "@ew/sdk";
import * as QRCode from "qrcode";
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

function optionText(options: ChannelConfig["options"], key: string): string {
  const value = options[key];
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

export function Channels() {
  const [adapters, setAdapters] = useState<ChannelAdapterMeta[]>([]);
  const [connectors, setConnectors] = useState<ChannelConfig[]>([]);
  const [statuses, setStatuses] = useState<ChannelStatus[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<ChannelConfig | null>(null);
  const [feishuSetup, setFeishuSetup] = useState<FeishuRegistrationSession | null>(null);
  const [feishuQr, setFeishuQr] = useState("");
  const [showFeishuAdvanced, setShowFeishuAdvanced] = useState(false);
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

  useEffect(() => {
    let alive = true;
    setFeishuQr("");
    if (!feishuSetup?.qrUrl) return;
    void QRCode.toDataURL(feishuSetup.qrUrl, {
      width: 190,
      margin: 1,
      color: { dark: "#0f172a", light: "#ffffff" },
    }).then((url) => {
      if (alive) setFeishuQr(url);
    }).catch(() => {});
    return () => {
      alive = false;
    };
  }, [feishuSetup?.qrUrl]);

  useEffect(() => {
    if (!feishuSetup || feishuSetup.status === "completed" || feishuSetup.status === "error" || feishuSetup.status === "aborted") return;
    let stopped = false;
    const tick = async () => {
      try {
        const next = await getClient().getFeishuRegistration(feishuSetup.id);
        if (stopped) return;
        setFeishuSetup(next);
        if (next.status === "completed") {
          setNote("Feishu / Lark 已连接");
          setEditing(null);
          await refresh();
        } else if (next.status === "error") {
          setNote(next.error || "Feishu / Lark 连接失败");
        } else if (next.status === "aborted") {
          setNote("已取消 Feishu / Lark 连接");
        }
      } catch (e) {
        if (!stopped) setNote(e instanceof Error ? e.message : String(e));
      }
    };
    const timer = window.setInterval(() => void tick(), 1500);
    void tick();
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [feishuSetup, refresh]);

  const startAdd = () => {
    const next = blankConfig(adapters);
    if (!next) {
      setNote("没有可用的渠道 adapter");
      return;
    }
    setEditing(next);
    setFeishuSetup(null);
    setShowFeishuAdvanced(false);
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

  const switchKind = (kind: ChannelConfig["kind"]) => {
    setEditing((cur) => {
      if (!cur) return cur;
      const id = cur.id.startsWith(`${cur.kind}-`) ? `${kind}-${crypto.randomUUID().slice(0, 8)}` : cur.id;
      return { ...cur, id, kind, secrets: {}, options: {}, auth: cur.auth };
    });
    setFeishuSetup(null);
    setShowFeishuAdvanced(false);
  };

  const startFeishuRegistration = async () => {
    if (!editing || editing.kind !== "feishu") return;
    setBusy(editing.id);
    setNote("");
    setFeishuSetup(null);
    try {
      const region = optionText(editing.options, "domain") === "lark" ? "lark" : "feishu";
      const session = await getClient().startFeishuRegistration({
        id: editing.id,
        displayName: editing.displayName || "Feishu / Lark",
        enabled: editing.enabled,
        region,
        auth: editing.auth,
      });
      setFeishuSetup(session);
      setNote("请用飞书 / Lark 扫码确认应用");
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const cancelFeishuRegistration = async () => {
    if (!feishuSetup) return;
    await getClient().cancelFeishuRegistration(feishuSetup.id).catch(() => {});
    setFeishuSetup(null);
    setFeishuQr("");
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
                  onClick={() => switchKind(k.kind)}
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
          {editing.kind === "feishu" && (
            <div className="set-row col">
              <div className="set-row-title">扫码连接</div>
              <div className="set-row-desc">默认使用长连接，不需要公网地址或 webhook 回调。</div>
              <div className="channels-connect-panel">
                <div className="channels-connect-main">
                  <div className="seg compact" data-testid="channels-feishu-region">
                    <button
                      className={(optionText(editing.options, "domain") || "feishu") === "feishu" ? "on" : ""}
                      onClick={() => patchEditing({ options: { ...editing.options, domain: "feishu" } })}
                    >
                      飞书
                    </button>
                    <button
                      className={optionText(editing.options, "domain") === "lark" ? "on" : ""}
                      onClick={() => patchEditing({ options: { ...editing.options, domain: "lark" } })}
                    >
                      Lark
                    </button>
                  </div>
                  <button
                    className="set-btn primary"
                    data-testid="channels-feishu-register"
                    onClick={() => void startFeishuRegistration()}
                    disabled={busy === editing.id}
                  >
                    {feishuSetup ? "重新生成二维码" : "扫码连接"}
                  </button>
                  <button className="set-btn ghost soft" onClick={() => setShowFeishuAdvanced((v) => !v)}>
                    {showFeishuAdvanced ? "收起高级配置" : "已有应用 / 高级配置"}
                  </button>
                </div>
                {feishuSetup && (
                  <div className="channels-qr-box" data-testid="channels-feishu-qr">
                    {feishuQr ? <img src={feishuQr} alt="Feishu setup QR code" /> : <div className="channels-qr-placeholder" />}
                    <div className="channels-qr-copy">
                      <div className="set-row-title">
                        {feishuSetup.status === "completed"
                          ? "已连接"
                          : feishuSetup.status === "error"
                            ? "连接失败"
                            : feishuSetup.status === "aborted"
                              ? "已取消"
                              : "等待扫码确认"}
                      </div>
                      <div className="set-row-desc">
                        {feishuSetup.error || feishuSetup.statusDetail || "使用飞书 / Lark 手机端扫描二维码。"}
                      </div>
                      <div className="set-row-control">
                        {feishuSetup.qrUrl && (
                          <a className="set-btn secondary small" href={feishuSetup.qrUrl} target="_blank" rel="noreferrer">
                            打开链接
                          </a>
                        )}
                        <button className="set-btn ghost soft small" onClick={() => void cancelFeishuRegistration()}>
                          取消
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
          {(!editing.kind || editing.kind !== "feishu" || showFeishuAdvanced) && (
            <div className="set-row col">
              <div className="set-row-title">必需密钥</div>
              <div className="set-row-desc">{editingMeta?.description ?? "按平台要求填写连接器密钥。"}</div>
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
          )}
          {!!editingMeta?.optionalSecrets?.length && (!editing.kind || editing.kind !== "feishu" || showFeishuAdvanced) && (
            <div className="set-row col">
              <div className="set-row-title">可选密钥</div>
              <div className="set-row-desc">用于平台回调校验、签名或加密事件解密。</div>
              <div className="channels-secret-grid">
                {editingMeta.optionalSecrets.map((s) => (
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
          )}
          {editing.kind === "telegram" && (
            <div className="set-row col">
              <div className="set-row-title">Telegram 选项</div>
              <div className="set-row-desc">可指定 Bot API baseUrl 和长轮询超时。</div>
              <div className="channels-secret-grid">
                <input
                  data-testid="channels-telegram-base-url"
                  placeholder="baseUrl（默认 https://api.telegram.org）"
                  value={optionText(editing.options, "baseUrl")}
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
          {editing.kind === "feishu" && showFeishuAdvanced && (
            <div className="set-row col">
              <div className="set-row-title">Feishu / Lark 选项</div>
              <div className="set-row-desc">长连接为默认模式；webhook 仅用于已有公网回调服务的高级场景。</div>
              <div className="channels-secret-grid">
                <select
                  data-testid="channels-feishu-transport"
                  value={optionText(editing.options, "transport") || "websocket"}
                  onChange={(e) => patchEditing({ options: { ...editing.options, transport: e.target.value } })}
                >
                  <option value="websocket">websocket</option>
                  <option value="webhook">webhook</option>
                </select>
                <input
                  data-testid="channels-feishu-base-url"
                  placeholder="baseUrl（默认 https://open.feishu.cn）"
                  value={optionText(editing.options, "baseUrl")}
                  onChange={(e) => patchEditing({ options: { ...editing.options, baseUrl: e.target.value } })}
                />
                <select
                  data-testid="channels-feishu-receive-id-type"
                  value={optionText(editing.options, "receiveIdType") || "chat_id"}
                  onChange={(e) => patchEditing({ options: { ...editing.options, receiveIdType: e.target.value } })}
                >
                  <option value="chat_id">chat_id</option>
                  <option value="open_id">open_id</option>
                  <option value="user_id">user_id</option>
                  <option value="union_id">union_id</option>
                  <option value="email">email</option>
                </select>
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
              <button className="set-btn ghost soft" onClick={() => {
                setEditing(null);
                setFeishuSetup(null);
              }}>
                取消
              </button>
              {editing.kind === "feishu" && !showFeishuAdvanced ? (
                <button className="set-btn primary" onClick={() => void startFeishuRegistration()} disabled={busy === editing.id}>
                  扫码连接
                </button>
              ) : (
                <button className="set-btn primary" onClick={() => void save()} disabled={busy === editing.id}>
                  {editing.enabled ? "保存并启动" : "保存"}
                </button>
              )}
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
            const transportLabel = c.kind === "feishu"
              ? (optionText(c.options, "transport") || "websocket")
              : meta?.supportsWebhook ? "webhook" : "long-poll";
            return (
              <div className="mcp-card" key={c.id} data-testid={`channels-card-${c.id}`}>
                <div className={`mcp-dot ${running ? "ok" : ""}`} />
              <div className="mcp-card-body">
                <div className="mcp-card-name">
                  <span>{c.displayName || c.id}</span>
                  <span className="set-pill">{kindLabel(c.kind, adapters)}</span>
                  {running ? <span className="set-pill">运行中</span> : <span className="set-pill ghost">已停止</span>}
                  <span className={transportLabel === "webhook" ? "set-pill" : "set-pill ghost"}>{transportLabel}</span>
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
                <button
                  className="mcp-icon-btn"
                  title="编辑"
                  onClick={() => {
                    setEditing(c);
                    setFeishuSetup(null);
                    setShowFeishuAdvanced(c.kind === "feishu");
                  }}
                  disabled={busy === c.id}
                >
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
