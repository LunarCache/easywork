import { useCallback, useEffect, useState } from "react";
import type { Project } from "@ew/shared";
import { getClient } from "../lib/client.js";
import { BrainIcon, TrashIcon, XIcon, EditIcon, CheckIcon, PlusIcon } from "../icons.js";

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

/** 记忆浮层：教 Agent 记住 + 按层分组浏览/删除（作用域切换：全局 / 各工作区）。 */
export function MemoryOverlay({ onClose, embedded }: { onClose?: () => void; embedded?: boolean }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [allMem, setAllMem] = useState<MemItem[]>([]);
  const [note, setNote] = useState("");
  const [emb, setEmb] = useState<{ ready: boolean; modelId?: string; dim: number } | null>(null);
  const [embBusy, setEmbBusy] = useState(false);

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

  const [draft, setDraft] = useState("");
  // 添加记忆弹层：目标 scope + layer（由层标题的 + 按钮设定）。
  const [adding, setAdding] = useState<{ scope: string; layer: string; label: string } | null>(null);
  const add = async () => {
    if (!adding) return;
    const text = draft.trim();
    if (!text) return;
    const { scope, layer } = adding;
    setAdding(null);
    setDraft("");
    try {
      await getClient().writeMemory({ scope, layer, text });
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

  // 记忆按 scope 分组 → 每组内按层分组（scope 标题 > 层标题 > 记忆项）。
  // scope 顺序：全局在前，工作区按项目顺序。
  const wsOrder = projects.map((p) => `ws:${p.id}`);
  const wsName = new Map(projects.map((p) => [`ws:${p.id}`, p.name]));
  const scopeIds = [...new Set([...wsOrder, ...allMem.map((m) => m.scope ?? GLOBAL_SCOPE)])];
  // 全局排到最前。
  scopeIds.sort((a, b) => {
    if (a === GLOBAL_SCOPE) return -1;
    if (b === GLOBAL_SCOPE) return 1;
    return wsOrder.indexOf(a) - wsOrder.indexOf(b);
  });
  const scopeBlocks = scopeIds
    .map((sid) => {
      const mem = allMem.filter((m) => (m.scope ?? GLOBAL_SCOPE) === sid);
      const order = sid === GLOBAL_SCOPE ? GLOBAL_ORDER : WS_ORDER;
      const layers = [...new Set([...order, ...mem.map((m) => m.layer)])]
        .map((layer) => ({ layer, items: mem.filter((m) => m.layer === layer) }))
        .filter((g) => g.items.length > 0);
      return { sid, name: sid === GLOBAL_SCOPE ? "全局 / 对话" : wsName.get(sid) ?? "工作区", layers };
    })
    .filter((b) => b.layers.length > 0);

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

        <div className="mem-ov-body">
          {note && <div className="mem-ov-note">{note}</div>}

          <div className="mem-ov-scroll">
            {scopeBlocks.length === 0 ? (
              <div className="mem-ov-empty">
                <BrainIcon size={26} />
                <p>暂无记忆</p>
                <button
                  className="kb-ov-upload"
                  onClick={() => {
                    setDraft("");
                    setAdding({ scope: GLOBAL_SCOPE, layer: "user-profile", label: "全局 · 用户画像 / 偏好" });
                  }}
                >
                  <PlusIcon size={15} /> 添加用户画像
                </button>
                <span>或随对话自动抽取。</span>
              </div>
            ) : (
              scopeBlocks.map((blk) => (
                <div key={blk.sid} className="mem-ov-group">
                  <div className="mem-ov-scope-h">{blk.name}</div>
                  {blk.layers.map((g) => (
                    <div key={g.layer}>
                      <div className="mem-ov-group-h">
                        <span>{LAYER_LABEL[g.layer] ?? g.layer}</span>
                        <button
                          className="mem-ov-layer-add"
                          title={`添加到「${LAYER_LABEL[g.layer] ?? g.layer}」`}
                          onClick={() => {
                            setDraft("");
                            setAdding({ scope: blk.sid, layer: g.layer, label: `${blk.name} · ${LAYER_LABEL[g.layer] ?? g.layer}` });
                          }}
                        >
                          <PlusIcon size={13} />
                        </button>
                      </div>
                      {g.items.map((m) => (
                        <div key={m.id} className="mem-ov-item">
                          <span className="mem-ov-dot" />
                          <div className="mem-ov-item-body">
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
                              <div className="mem-ov-item-text">{m.text}</div>
                            )}
                            <div className="mem-ov-item-meta">
                              {m.sessionId ? "本会话" : blk.name} · {relTime(m.updatedAt)}
                            </div>
                          </div>
                          {editing?.id === m.id ? (
                            <button className="mem-ov-del show" title="保存" onClick={() => void saveEdit()}>
                              <CheckIcon size={14} />
                            </button>
                          ) : (
                            <button className="mem-ov-del" title="编辑" onClick={() => setEditing({ id: m.id, text: m.text })}>
                              <EditIcon size={14} />
                            </button>
                          )}
                          <button className="mem-ov-del" title="删除" onClick={() => void del(m.id)}>
                            <TrashIcon size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              ))
            )}
          </div>

          {/* 添加记忆弹层（仿知识库上传目标选择） */}
          {adding && (
            <div className="kb-pick-mask" onClick={() => setAdding(null)}>
              <div className="kb-confirm" onClick={(e) => e.stopPropagation()}>
                <div className="kb-pick-head">
                  <span>添加到「{adding.label}」</span>
                  <button className="kb-pv-btn" title="取消" onClick={() => setAdding(null)}>
                    <XIcon size={15} />
                  </button>
                </div>
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
                <div className="kb-confirm-actions">
                  <span className="mem-add-hint">⌘↵ 保存</span>
                  <span className="ad-spacer" />
                  <button className="kb-confirm-cancel" onClick={() => setAdding(null)}>
                    取消
                  </button>
                  <button className="kb-confirm-del" onClick={() => void add()} disabled={!draft.trim()}>
                    添加
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className="mem-ov-foot">
            <span>
              向量召回：{emb?.ready ? `已启用 · ${emb.dim} 维` : "未启用（词法召回）"}
            </span>
            {!emb?.ready && (
              <button onClick={() => void enableEmbedding()} disabled={embBusy}>
                {embBusy ? "处理中…" : "启用向量召回"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
