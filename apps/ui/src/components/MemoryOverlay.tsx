import { useCallback, useEffect, useState } from "react";
import type { Project } from "@ew/shared";
import { getClient } from "../lib/client.js";
import { BrainIcon, TrashIcon, XIcon, EditIcon, CheckIcon, PlusIcon, SearchIcon, UserIcon, FolderClosedIcon } from "../icons.js";

interface MemItem {
  id: string;
  scope?: string;
  layer: string;
  text: string;
  sessionId?: string;
  updatedAt: string;
}

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
  const [selectedScope, setSelectedScope] = useState<string>(GLOBAL_SCOPE);
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
      setSelectedScope(scope);
      await refresh();
    } catch (e) {
      setNote(`添加失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const del = async (id: string) => {
    await getClient().deleteMemory(id);
    await refresh();
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
  const scopeIds = [GLOBAL_SCOPE, ...projects.map((p) => `ws:${p.id}`)];
  const sel = scopeIds.includes(selectedScope) ? selectedScope : GLOBAL_SCOPE;
  const q = query.trim().toLowerCase();

  const openAdd = (scope: string, layer?: string) => {
    setDraft("");
    setAdding(
      layer
        ? { scope, layer, label: `${scopeName(scope) === "全局 / 你" ? "全局" : scopeName(scope)} · ${LAYER_LABEL[layer] ?? layer}` }
        : { scope, layer: layerOrder(scope)[0]!, label: "", pick: true },
    );
  };

  // 选中作用域内、按层分组（保留层顺序，搜索时仅留命中层）。
  const layers = layerOrder(sel).map((layer) => {
    const items = allMem
      .filter((m) => scopeOf(m) === sel && m.layer === layer)
      .filter((m) => !q || m.text.toLowerCase().includes(q))
      .sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1));
    return { layer, items };
  });
  const selHasAny = layers.some((l) => l.items.length > 0);

  return (
    <div className={embedded ? "ad-page-embed" : "ad-overlay"} onClick={embedded ? undefined : onClose}>
      <div className={`ad-overlay-card mem-ov-card ${embedded ? "embed" : ""}`} onClick={(e) => e.stopPropagation()}>
        <div className="ad-ov-head mem-ov-head">
          <span className="mem-ov-ico">
            <BrainIcon size={18} />
          </span>
          <div className="mem-ov-titles">
            <span className="ad-ov-title">记忆</span>
            <span className="mem-ov-sub">Agent 跨会话记住的内容</span>
          </div>
          <span className="ad-spacer" />
          {!embedded && (
            <button className="ad-ov-close" title="关闭" onClick={onClose}>
              <XIcon size={15} />
            </button>
          )}
        </div>

        {/* 工具栏：搜索 + 向量召回状态 + 添加 */}
        <div className="mem-toolbar">
          <div className="mem-search">
            <SearchIcon size={15} />
            <input placeholder="搜索记忆…" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <span className="mem-recall">
            <span className="mem-recall-dot" data-on={emb?.ready ? "1" : "0"} />
            {emb?.ready ? `向量召回 · ${emb.dim} 维` : "向量召回未启用"}
            {!emb?.ready && (
              <button className="mem-recall-btn" onClick={() => void enableEmbedding()} disabled={embBusy}>
                {embBusy ? "处理中…" : "启用"}
              </button>
            )}
          </span>
          <button className="mem-add-btn" onClick={() => openAdd(sel)}>
            <PlusIcon size={15} /> 添加
          </button>
        </div>

        {note && <div className="mem-ov-note">{note}</div>}

        {/* 档案：左作用域栏 + 右层分区 */}
        <div className="mem-doss">
          <div className="mem-rail">
            <div className="mem-rail-h">作用域</div>
            <button className={`mem-scope ${sel === GLOBAL_SCOPE ? "on" : ""}`} onClick={() => setSelectedScope(GLOBAL_SCOPE)}>
              <span className="mem-av">
                <UserIcon size={15} />
              </span>
              <span className="mem-nm">全局 / 你</span>
              <span className="mem-ct">{allMem.filter((m) => scopeOf(m) === GLOBAL_SCOPE).length}</span>
            </button>
            {projects.length > 0 && <div className="mem-rail-h">工作区</div>}
            {projects.map((p) => {
              const sid = `ws:${p.id}`;
              const ct = allMem.filter((m) => scopeOf(m) === sid).length;
              return (
                <button
                  key={p.id}
                  className={`mem-scope ${sel === sid ? "on" : ""} ${ct === 0 ? "empty" : ""}`}
                  title={p.workspaceDir}
                  onClick={() => setSelectedScope(sid)}
                >
                  <span className="mem-av">
                    <FolderClosedIcon size={14} />
                  </span>
                  <span className="mem-nm">{p.name}</span>
                  <span className="mem-ct">{ct}</span>
                </button>
              );
            })}
          </div>

          <div className="mem-main">
            <div className="mem-main-h">
              <h2>{scopeName(sel)}</h2>
            </div>
            <div className="mem-main-sub">
              {sel === GLOBAL_SCOPE ? "所有对话共享 · 助手跨会话记住的关于你的内容" : "本工作区私有池 · 与全局隔离"}
            </div>

            {q && !selHasAny ? (
              <div className="mem-empty">
                <SearchIcon size={24} />
                <p>无匹配「{query}」</p>
              </div>
            ) : (
              layers.map(({ layer, items }) => {
                if (q && items.length === 0) return null; // 搜索时隐藏空层
                return (
                  <div key={layer} className="mem-sect">
                    <div className="mem-sect-h">
                      <span className="mem-dot" style={{ background: LAYER_COLOR[layer] ?? "var(--accent)" }} />
                      <span className="mem-sect-lbl">{LAYER_LABEL[layer] ?? layer}</span>
                      <span className="mem-sect-ct">{items.length}</span>
                      <button className="mem-sect-add" title={`添加到「${LAYER_LABEL[layer] ?? layer}」`} onClick={() => openAdd(sel, layer)}>
                        <PlusIcon size={14} />
                      </button>
                    </div>
                    {items.length === 0 ? (
                      <div className="mem-sect-empty">暂无 · 点 + 添加</div>
                    ) : (
                      items.map((m) => (
                        <div key={m.id} className="mem-card">
                          {editing?.id === m.id ? (
                            <input
                              className="mem-ov-edit"
                              autoFocus
                              value={editing.text}
                              onChange={(e) => setEditing({ id: m.id, text: e.target.value })}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") void saveEdit();
                                else if (e.key === "Escape") setEditing(null);
                              }}
                            />
                          ) : (
                            <div className="mem-card-txt">{m.text}</div>
                          )}
                          <div className="mem-card-meta">
                            <span className={`mem-src ${m.sessionId ? "auto" : "man"}`}>{m.sessionId ? "自动抽取" : "手动"}</span>
                            <span className="mem-time">{relTime(m.updatedAt)}</span>
                            <span className="ad-spacer" />
                            {editing?.id === m.id ? (
                              <button className="mem-card-act show" title="保存" onClick={() => void saveEdit()}>
                                <CheckIcon size={14} />
                              </button>
                            ) : (
                              <button className="mem-card-act" title="编辑" onClick={() => setEditing({ id: m.id, text: m.text })}>
                                <EditIcon size={14} />
                              </button>
                            )}
                            <button className="mem-card-act" title="删除" onClick={() => void del(m.id)}>
                              <TrashIcon size={14} />
                            </button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* 添加记忆弹层 */}
        {adding && (
          <div className="confirm-mask" onClick={() => setAdding(null)}>
            <div className="confirm-box wide" onClick={(e) => e.stopPropagation()}>
              <div className="confirm-title">{adding.pick ? "添加记忆" : `添加到「${adding.label}」`}</div>
              {adding.pick && (
                <div className="mem-add-pickers">
                  <select
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
                  <select value={adding.layer} onChange={(e) => setAdding((a) => (a ? { ...a, layer: e.target.value } : a))}>
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
                <button className="confirm-cancel" onClick={() => setAdding(null)}>
                  取消
                </button>
                <button className="confirm-ok" onClick={() => void add()} disabled={!draft.trim()}>
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
