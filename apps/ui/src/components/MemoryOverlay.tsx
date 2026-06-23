import { useCallback, useEffect, useState } from "react";
import type { Project } from "@ew/shared";
import { getClient } from "../lib/client.js";
import { BrainIcon, TrashIcon, XIcon, ChatIcon, FolderClosedIcon, EditIcon, CheckIcon } from "../icons.js";

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
// 手动「添加」时落到的层（按作用域取一个合适的默认）。
const ADD_LAYER: Record<string, string> = { [GLOBAL_SCOPE]: "agent-memory" };

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
  const [scope, setScope] = useState<string>(GLOBAL_SCOPE);
  const [items, setItems] = useState<MemItem[]>([]);
  const [note, setNote] = useState("");
  const [emb, setEmb] = useState<{ ready: boolean; modelId?: string; dim: number } | null>(null);
  const [embBusy, setEmbBusy] = useState(false);

  const isWs = scope !== GLOBAL_SCOPE;
  const scopeName = isWs ? (projects.find((p) => `ws:${p.id}` === scope)?.name ?? "工作区") : "全局";

  const refresh = useCallback(async () => {
    try {
      setItems(await getClient().listMemory({ scope }));
    } catch {
      /* ignore */
    }
  }, [scope]);

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
  const add = async () => {
    const text = draft.trim();
    if (!text) return;
    const layer = ADD_LAYER[scope] ?? (isWs ? "conventions" : "agent-memory");
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

  const clearScope = async () => {
    if (!confirm(`清空「${scopeName}」作用域的全部记忆？此操作不可撤销（含由对话自动抽取的事实）。`)) return;
    try {
      const { removed } = await getClient().clearMemoryScope(scope);
      setNote(`已清空 ${removed} 条记忆。`);
      await refresh();
    } catch (e) {
      setNote(`清空失败：${e instanceof Error ? e.message : String(e)}`);
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

  // 按层分组（保持既定顺序，未知层置尾）。
  const order = isWs ? WS_ORDER : GLOBAL_ORDER;
  const groups = [...new Set([...order, ...items.map((m) => m.layer)])]
    .map((layer) => ({ layer, items: items.filter((m) => m.layer === layer) }))
    .filter((g) => g.items.length > 0);

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
          <div className="mem-ov-add">
            <input
              placeholder="教 Agent 记住点什么…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void add()}
            />
            <button className="mem-ov-add-btn" onClick={() => void add()} disabled={!draft.trim()}>
              添加
            </button>
          </div>

          <div className="mem-ov-scopes">
            <button className={`mem-ov-scope ${!isWs ? "on" : ""}`} onClick={() => setScope(GLOBAL_SCOPE)}>
              <ChatIcon size={13} /> 全局 / 对话
            </button>
            {projects.map((p) => (
              <button
                key={p.id}
                className={`mem-ov-scope ${scope === `ws:${p.id}` ? "on" : ""}`}
                title={p.workspaceDir}
                onClick={() => setScope(`ws:${p.id}`)}
              >
                <FolderClosedIcon size={13} /> {p.name}
              </button>
            ))}
          </div>

          {note && <div className="mem-ov-note">{note}</div>}

          <div className="mem-ov-scroll">
            {groups.length === 0 ? (
              <div className="mem-ov-empty">
                <BrainIcon size={26} />
                <p>暂无记忆</p>
                <span>在上方教 Agent 记住点什么，或随对话自动抽取。</span>
              </div>
            ) : (
              groups.map((g) => (
                <div key={g.layer} className="mem-ov-group">
                  <div className="mem-ov-group-h">{LAYER_LABEL[g.layer] ?? g.layer}</div>
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
                          {m.sessionId ? "本会话" : scopeName} · {relTime(m.updatedAt)}
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
              ))
            )}
          </div>

          <div className="mem-ov-foot">
            <span>
              向量召回：{emb?.ready ? `已启用 · ${emb.dim} 维` : "未启用（词法召回）"}
            </span>
            {!emb?.ready && (
              <button onClick={() => void enableEmbedding()} disabled={embBusy}>
                {embBusy ? "处理中…" : "启用向量召回"}
              </button>
            )}
            {items.length > 0 && (
              <button className="mem-ov-clear" onClick={() => void clearScope()}>
                清空此作用域
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
