import { useCallback, useEffect, useState } from "react";
import type { MemoryItem, Project } from "@ew/shared";
import { getClient } from "../lib/client.js";
import { BrainIcon, TrashIcon, XIcon, EditIcon, CheckIcon, PlusIcon, SearchIcon, UserIcon, FolderClosedIcon } from "../icons.js";

type MemItem = MemoryItem;

const GLOBAL_SCOPE = "global";
const GLOBAL_ORDER = ["user-profile", "agent-memory", "skills"];
const WS_ORDER = ["conventions", "decisions", "pitfalls"];
const LAYER_LABEL: Record<string, string> = {
  "user-profile": "用户画像 / 偏好",
  "agent-memory": "助手记忆",
  skills: "技能",
  conventions: "约定 / 约束",
  decisions: "变动 / 决策",
  pitfalls: "坑 / 教训",
};
// 层语义色（小圆点 / 分区标识；两套主题下都用显式色值）。
const LAYER_COLOR: Record<string, string> = {
  "user-profile": "#3B82F6",
  "agent-memory": "#7C84FF",
  skills: "#A06CF5",
  conventions: "#3FB950",
  decisions: "#D29922",
  pitfalls: "#F85149",
};
const ORIGIN_PRESENTATION: Record<MemoryItem["origin"], { label: string; className: string }> = {
  manual: { label: "手动", className: "man" },
  "agent-managed": { label: "Agent 管理", className: "agent" },
  extracted: { label: "自动提取", className: "auto" },
  imported: { label: "既有 / 导入", className: "imported" },
  provider: { label: "外部 Provider", className: "provider" },
};
const layerOrder = (scope: string) => (scope === GLOBAL_SCOPE ? GLOBAL_ORDER : WS_ORDER);

function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天前`;
  return `${Math.floor(s / (86400 * 30))} 个月前`;
}

/**
 * 记忆页（档案 Dossier）：左侧作用域栏（全局 / 你 + 各工作区，带计数），
 * 右侧是选中作用域的「档案」—— 按层分区（语义色 + 计数 + 行内添加），
 * 记忆项含来源徽章（手动 / 自动抽取）+ 时间 + 行内编辑/删除。顶部搜索 + 向量召回状态。
 */
export function MemoryOverlay({ onClose, embedded }: { onClose?: () => void; embedded?: boolean }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [allMem, setAllMem] = useState<MemItem[]>([]);
  const [note, setNote] = useState("");
  const [emb, setEmb] = useState<{ ready: boolean; modelId?: string; dim: number } | null>(null);
  const [embBusy, setEmbBusy] = useState(false);
  // 信息流筛选：作用域（"all" / global / ws:<id>）+ 可选分类层。
  const [scopeFilter, setScopeFilter] = useState<string>("all");
  const [layerFilter, setLayerFilter] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const refresh = useCallback(async () => {
    try {
      setAllMem(await getClient().listMemory());
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void (async () => {
      try {
        setProjects(await getClient().listProjects());
      } catch {
        /* ignore */
      }
      try {
        setEmb(await getClient().embeddingStatus());
      } catch {
        /* ignore */
      }
    })();
  }, []);

  // 添加记忆弹层：目标 scope + layer。pick=true 时弹层内可自选 scope/层（给空作用域/空层加第一条）。
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState<{ scope: string; layer: string; label: string; pick?: boolean } | null>(null);
  const add = async () => {
    if (!adding) return;
    const text = draft.trim();
    if (!text) return;
    const { scope, layer } = adding;
    setAdding(null);
    setDraft("");
    try {
      await getClient().writeMemory({ scope, layer, text });
      setScopeFilter(scope);
      setLayerFilter(null);
      await refresh();
    } catch (e) {
      setNote(`添加失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const del = async (id: string) => {
    await getClient().deleteMemory(id);
    await refresh();
  };

  const promote = async (id: string) => {
    try {
      await getClient().pinMemory(id);
      setNote("已确认并保留；删除来源对话不会再删除这条事实。");
      await refresh();
    } catch (e) {
      setNote(`确认失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const saveEdit = async () => {
    if (!editing) return;
    const text = editing.text.trim();
    const id = editing.id;
    setEditing(null);
    if (!text) return;
    try {
      await getClient().editMemory(id, text);
      await refresh();
    } catch (e) {
      setNote(`修改失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const enableEmbedding = async () => {
    setEmbBusy(true);
    setNote("正在下载/加载本地 embedding 模型（nomic，~84MB，CPU）并重建索引…");
    try {
      const r = await getClient().enableEmbedding();
      setEmb({ ready: r.ready, ...(r.modelId ? { modelId: r.modelId } : {}), dim: r.dim });
      setNote(`向量召回已启用（${r.dim} 维），重建 ${r.reindexed} 条索引。`);
    } catch (e) {
      setNote(`启用失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setEmbBusy(false);
    }
  };

  // —— 派生数据 ——
  const scopeOf = (m: MemItem) => m.scope ?? GLOBAL_SCOPE;
  const scopeName = (sid: string) =>
    sid === GLOBAL_SCOPE ? "全局 / 你" : projects.find((p) => `ws:${p.id}` === sid)?.name ?? "工作区";
  const countScope = (sid: string) => allMem.filter((m) => scopeOf(m) === sid).length;
  const q = query.trim().toLowerCase();
  // 选中具体作用域时才展示其分类层 chips（"全部"视图不按层筛，避免跨作用域层语义混淆）。
  const catLayers = scopeFilter === "all" ? [] : layerOrder(scopeFilter);

  const openAdd = (scope: string, layer?: string) => {
    setDraft("");
    setAdding(
      layer
        ? { scope, layer, label: `${scopeName(scope) === "全局 / 你" ? "全局" : scopeName(scope)} · ${LAYER_LABEL[layer] ?? layer}` }
        : { scope, layer: layerOrder(scope)[0]!, label: "", pick: true },
    );
  };
  // 顶部「添加」：具体作用域+层已筛 → 直接加；否则弹层自选 scope/层。
  const openAddTop = () => {
    if (scopeFilter !== "all" && layerFilter) openAdd(scopeFilter, layerFilter);
    else openAdd(scopeFilter === "all" ? GLOBAL_SCOPE : scopeFilter);
  };

  // 单列信息流：按作用域 / 分类 / 搜索过滤，时间倒序。
  const feed = allMem
    .filter((m) => scopeFilter === "all" || scopeOf(m) === scopeFilter)
    .filter((m) => !layerFilter || m.layer === layerFilter)
    .filter((m) => !q || m.text.toLowerCase().includes(q))
    .sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1));

  const originPresentation = (m: MemItem): { label: string; className: string } => {
    const presentation = ORIGIN_PRESENTATION[m.origin];
    return m.origin === "extracted" && m.state === "curated"
      ? { ...presentation, label: `${presentation.label} · 已确认` }
      : presentation;
  };

  return (
    <div className={embedded ? "ad-page-embed" : "ad-overlay"} onClick={embedded ? undefined : onClose}>
      <div
        className={`ad-overlay-card mem-ov-card ${embedded ? "embed" : ""}`}
        data-testid="memory-overlay"
        onClick={(e) => e.stopPropagation()}
      >
        {!embedded && (
          <div className="ad-ov-head mem-ov-head">
            <span className="mem-ov-ico">
              <BrainIcon size={18} />
            </span>
            <div className="mem-ov-titles">
              <span className="ad-ov-title">记忆</span>
              <span className="mem-ov-sub">Agent 跨会话记住的内容</span>
            </div>
            <span className="ad-spacer" />
            <button className="ad-ov-close" title="关闭" onClick={onClose}>
              <XIcon size={15} />
            </button>
          </div>
        )}

        {/* 工具栏：搜索 + 向量召回状态 + 添加 */}
        <div className="mem-toolbar">
          <div className="mem-search">
            <SearchIcon size={15} />
            <input
              data-testid="memory-search-input"
              placeholder="搜索记忆…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <span className="mem-recall">
            <span className="mem-recall-dot" data-on={emb?.ready ? "1" : "0"} />
            {emb?.ready ? `向量召回 · ${emb.dim} 维` : "向量召回未启用"}
            {!emb?.ready && (
              <button className="set-btn tiny" onClick={() => void enableEmbedding()} disabled={embBusy}>
                {embBusy ? "处理中…" : "启用"}
              </button>
            )}
          </span>
          <button className="set-btn primary" data-testid="memory-add-button" onClick={openAddTop}>
            <PlusIcon size={15} /> 添加
          </button>
        </div>

        {note && <div className="mem-ov-note">{note}</div>}

        {/* 筛选 chips：作用域 + （选中具体作用域时）分类层 */}
        <div className="mem-filters">
          <button className={`mem-chip ${scopeFilter === "all" ? "on" : ""}`} onClick={() => { setScopeFilter("all"); setLayerFilter(null); }}>
            全部
            <span className="mem-chip-ct">{allMem.length}</span>
          </button>
          <button
            className={`mem-chip ${scopeFilter === GLOBAL_SCOPE ? "on" : ""}`}
            onClick={() => { setScopeFilter(GLOBAL_SCOPE); setLayerFilter(null); }}
          >
            <UserIcon size={13} /> 全局·你
            <span className="mem-chip-ct">{countScope(GLOBAL_SCOPE)}</span>
          </button>
          {projects.map((p) => {
            const sid = `ws:${p.id}`;
            return (
              <button
                key={p.id}
                className={`mem-chip ${scopeFilter === sid ? "on" : ""}`}
                title={p.workspaceDir}
                onClick={() => { setScopeFilter(sid); setLayerFilter(null); }}
              >
                <FolderClosedIcon size={12} /> {p.name}
                <span className="mem-chip-ct">{countScope(sid)}</span>
              </button>
            );
          })}
          {catLayers.length > 0 && (
            <>
              <span className="mem-filters-sep" />
              {catLayers.map((l) => (
                <button
                  key={l}
                  className={`mem-chip cat ${layerFilter === l ? "on" : ""}`}
                  onClick={() => setLayerFilter(layerFilter === l ? null : l)}
                >
                  <span className="mem-dot" style={{ background: LAYER_COLOR[l] ?? "var(--accent)" }} />
                  {LAYER_LABEL[l] ?? l}
                </button>
              ))}
            </>
          )}
        </div>

        {/* 单列卡片信息流 */}
        {feed.length === 0 ? (
          <div className="mem-empty feed">
            <BrainIcon size={26} />
            <p>{q ? `无匹配「${query}」` : "暂无记忆 · 点右上「添加」教 Agent 记住点什么"}</p>
          </div>
        ) : (
          <div className="mem-feed">
            {feed.map((m) => {
              const origin = originPresentation(m);
              return <div key={m.id} className="mem-fcard" data-testid={`memory-card-${m.id}`}>
                {editing?.id === m.id ? (
                  <input
                    className="mem-ov-edit"
                    data-testid={`memory-edit-input-${m.id}`}
                    autoFocus
                    value={editing.text}
                    onChange={(e) => setEditing({ id: m.id, text: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void saveEdit();
                      else if (e.key === "Escape") setEditing(null);
                    }}
                  />
                ) : (
                  <div className="mem-fcard-txt">{m.text}</div>
                )}
                <div className="mem-fcard-meta">
                  <span className="mem-fscope">
                    {scopeOf(m) === GLOBAL_SCOPE ? <UserIcon size={12} /> : <FolderClosedIcon size={11} />}
                    {scopeName(scopeOf(m))}
                  </span>
                  <span className="mem-fcat">
                    <span className="mem-dot" style={{ background: LAYER_COLOR[m.layer] ?? "var(--accent)" }} />
                    {LAYER_LABEL[m.layer] ?? m.layer}
                  </span>
                  <span className={`mem-src ${origin.className}`}>{origin.label}</span>
                  {m.sourceThreadId && (
                    <span className="mem-source-thread" title={m.sourceThreadId}>
                      来源 {m.sourceThreadId.slice(0, 8)} · 随来源对话删除
                    </span>
                  )}
                  <span className="mem-time">{relTime(m.updatedAt)}</span>
                  <span className="ad-spacer" />
                  {m.origin === "extracted" && m.state === "derived" && (
                    <button
                      className="mem-promote"
                      data-testid={`memory-promote-${m.id}`}
                      title="提升为独立长期记忆"
                      onClick={() => void promote(m.id)}
                    >
                      <CheckIcon size={12} /> 确认并保留
                    </button>
                  )}
                  {editing?.id === m.id ? (
                    <button className="mem-card-act show" data-testid={`memory-save-${m.id}`} title="保存" onClick={() => void saveEdit()}>
                      <CheckIcon size={14} />
                    </button>
                  ) : (
                    <button
                      className="mem-card-act"
                      data-testid={`memory-edit-${m.id}`}
                      title="编辑"
                      onClick={() => setEditing({ id: m.id, text: m.text })}
                    >
                      <EditIcon size={14} />
                    </button>
                  )}
                  <button className="mem-card-act" data-testid={`memory-delete-${m.id}`} title="删除" onClick={() => void del(m.id)}>
                    <TrashIcon size={14} />
                  </button>
                </div>
              </div>;
            })}
          </div>
        )}

        {/* 添加记忆弹层 */}
        {adding && (
          <div className="confirm-mask" onClick={() => setAdding(null)}>
            <div className="confirm-box wide" data-testid="memory-add-dialog" onClick={(e) => e.stopPropagation()}>
              <div className="confirm-title">{adding.pick ? "添加记忆" : `添加到「${adding.label}」`}</div>
              {adding.pick && (
                <div className="mem-add-pickers">
                  <select
                    data-testid="memory-add-scope"
                    value={adding.scope}
                    onChange={(e) => {
                      const scope = e.target.value;
                      const layer = layerOrder(scope)[0]!;
                      setAdding((a) => (a ? { ...a, scope, layer } : a));
                    }}
                  >
                    <option value={GLOBAL_SCOPE}>全局 / 对话</option>
                    {projects.map((p) => (
                      <option key={p.id} value={`ws:${p.id}`}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <select
                    data-testid="memory-add-layer"
                    value={adding.layer}
                    onChange={(e) => setAdding((a) => (a ? { ...a, layer: e.target.value } : a))}
                  >
                    {layerOrder(adding.scope).map((l) => (
                      <option key={l} value={l}>
                        {LAYER_LABEL[l] ?? l}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <textarea
                className="mem-add-textarea"
                data-testid="memory-add-textarea"
                autoFocus
                placeholder="教 Agent 记住点什么…"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void add();
                  else if (e.key === "Escape") setAdding(null);
                }}
              />
              <div className="confirm-actions">
                <span className="mem-add-hint">⌘↵ 保存</span>
                <span className="ad-spacer" />
                <button className="set-btn ghost soft" data-testid="memory-add-cancel" onClick={() => setAdding(null)}>
                  取消
                </button>
                <button className="set-btn primary" data-testid="memory-add-submit" onClick={() => void add()} disabled={!draft.trim()}>
                  添加
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
