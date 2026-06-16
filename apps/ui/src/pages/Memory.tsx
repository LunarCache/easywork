import { useCallback, useEffect, useState } from "react";
import type { Project } from "@ew/shared";
import { getClient } from "../lib/client.js";
import { SparkIcon, SearchIcon, EditIcon, TrashIcon, CheckIcon, FolderClosedIcon, ChatIcon } from "../icons.js";

interface MemItem {
  id: string;
  scope?: string;
  layer: string;
  text: string;
  sessionId?: string;
  updatedAt: string;
}

const GLOBAL_SCOPE = "global";
// 各作用域的层标签（global = 对话/全局；ws = 工作区工程记忆）。
const GLOBAL_LAYERS: { id: string; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "user-profile", label: "用户画像" },
  { id: "agent-memory", label: "助手记忆" },
  { id: "skills", label: "技能" },
];
const WORKSPACE_LAYERS: { id: string; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "conventions", label: "约定/约束" },
  { id: "decisions", label: "变动/决策" },
  { id: "pitfalls", label: "坑/教训" },
];
const LAYER_LABEL: Record<string, string> = {
  "user-profile": "用户画像",
  "agent-memory": "助手记忆",
  skills: "技能",
  conventions: "约定/约束",
  decisions: "变动/决策",
  pitfalls: "坑/教训",
};

export function Memory() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [scope, setScope] = useState<string>(GLOBAL_SCOPE);
  const [items, setItems] = useState<MemItem[]>([]);
  const [layer, setLayer] = useState<string>("all");
  const [embStatus, setEmbStatus] = useState<{ ready: boolean; modelId?: string; dim: number } | null>(null);
  const [embBusy, setEmbBusy] = useState(false);
  const [note, setNote] = useState("");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<{ text: string; score?: number; layer: string }[] | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);

  const isWorkspace = scope !== GLOBAL_SCOPE;
  const layerDefs = isWorkspace ? WORKSPACE_LAYERS : GLOBAL_LAYERS;

  const refresh = useCallback(async () => {
    try {
      const c = getClient();
      setItems(await c.listMemory({ scope, ...(layer === "all" ? {} : { layer }) }));
    } catch {
      /* ignore */
    }
  }, [scope, layer]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 初次：拉取 embedding 状态 + 工作区列表（供作用域切换）。
  useEffect(() => {
    void (async () => {
      const c = getClient();
      try {
        setEmbStatus(await c.embeddingStatus());
      } catch {
        /* ignore */
      }
      try {
        setProjects(await c.listProjects());
      } catch {
        /* ignore */
      }
    })();
  }, []);

  // 切作用域时重置层过滤 + 召回结果。
  const selectScope = (s: string) => {
    setScope(s);
    setLayer("all");
    setHits(null);
  };

  const enableEmbedding = async () => {
    setEmbBusy(true);
    setNote("正在下载/加载本地 embedding 模型（nomic，~84MB，CPU）并重建索引…");
    try {
      const r = await getClient().enableEmbedding();
      setEmbStatus({ ready: r.ready, ...(r.modelId ? { modelId: r.modelId } : {}), dim: r.dim });
      setNote(`向量召回已启用（${r.dim} 维），重建 ${r.reindexed} 条记忆索引。`);
    } catch (e) {
      setNote(`启用失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setEmbBusy(false);
    }
  };

  const recall = async () => {
    if (!query.trim()) return;
    setHits(await getClient().recallMemory(query.trim(), 6, scope));
  };

  const saveEdit = async () => {
    if (!editing || !editing.text.trim()) return;
    await getClient().editMemory(editing.id, editing.text);
    setEditing(null);
    await refresh();
  };

  const del = async (id: string) => {
    await getClient().deleteMemory(id);
    await refresh();
  };

  const clearScope = async () => {
    if (!isWorkspace) return;
    if (
      !confirm(
        `清空工作区「${scopeName}」的全部记忆？\n\n` +
          `此操作不可撤销，仅清空该工程的私有记忆池（约定/变动/坑），` +
          `不影响全局记忆与其他工作区，也不会删除工作区目录中的任何文件。`,
      )
    )
      return;
    try {
      const { removed } = await getClient().clearMemoryScope(scope);
      setNote(`已清空「${scopeName}」记忆池：删除 ${removed} 条。`);
      await refresh();
    } catch (e) {
      setNote(`清空失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const scopeName = isWorkspace ? (projects.find((p) => `ws:${p.id}` === scope)?.name ?? "工作区") : "全局/对话";

  return (
    <div className="page">
      <div className="page-head">
        <span className="ico">
          <SparkIcon size={20} />
        </span>
        <div>
          <h2>记忆</h2>
          <p className="lead">
            作用域化：全局池（所有对话共享）+ 每个工作区独立池（互相隔离）。系统提示词只注入「清单」，
            模型按需用 recall_memory 取全文；对话停顿/压缩时批量抽取。
          </p>
        </div>
      </div>
      {note && <div className="note">{note}</div>}

      {/* 作用域选择 */}
      <section>
        <div className="sec-head">
          <span className="ico">
            <FolderClosedIcon size={18} />
          </span>
          <div>
            <h3>作用域</h3>
            <p className="hint">全局记忆与对话互通；工作区记忆只属于该工程，相互隔离、独立于全局。</p>
          </div>
        </div>
        <div className="mem-scopes">
          <button className={`mem-scope ${scope === GLOBAL_SCOPE ? "on" : ""}`} onClick={() => selectScope(GLOBAL_SCOPE)}>
            <ChatIcon size={14} /> 全局 / 对话
          </button>
          {projects.map((p) => (
            <button
              key={p.id}
              className={`mem-scope ${scope === `ws:${p.id}` ? "on" : ""}`}
              onClick={() => selectScope(`ws:${p.id}`)}
              title={p.workspaceDir}
            >
              <FolderClosedIcon size={14} /> {p.name}
            </button>
          ))}
        </div>
      </section>

      {/* 向量召回状态（全局设施） */}
      <section>
        <div className="sec-head">
          <span className="ico green">
            <SparkIcon size={18} />
          </span>
          <div>
            <h3>向量召回</h3>
            <p className="hint">本地 CPU embedding（nomic-embed-text），经 sqlite-vec 检索。未启用时降级为纯词法。</p>
          </div>
        </div>
        <div className="sub">
          状态：{embStatus?.ready ? `已启用（${embStatus.dim} 维 · ${embStatus.modelId}）` : "未启用（词法召回）"}
        </div>
        <button className="btn" style={{ marginTop: 8 }} onClick={() => void enableEmbedding()} disabled={embBusy || embStatus?.ready}>
          {embBusy ? "处理中…" : embStatus?.ready ? "已启用" : "启用向量召回（下载 nomic CPU 模型）"}
        </button>
      </section>

      {/* 召回测试（按当前作用域） */}
      <section>
        <div className="sec-head">
          <span className="ico blue">
            <SearchIcon size={18} />
          </span>
          <div>
            <h3>召回测试 · {scopeName}</h3>
            <p className="hint">输入查询，查看该作用域内的混合召回命中与相关度分数。</p>
          </div>
        </div>
        <div className="row" style={{ maxWidth: 640 }}>
          <div className="field">
            <SearchIcon size={16} />
            <input
              placeholder={isWorkspace ? "如：这个项目的约束" : "如：我养的宠物"}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void recall()}
            />
          </div>
          <button onClick={() => void recall()}>召回</button>
        </div>
        {hits?.map((h, i) => (
          <div key={i} className="mem-hit">
            <span className="mem-layer">{LAYER_LABEL[h.layer] ?? h.layer}</span>
            {h.text}
            {h.score != null && <span className="mem-score">{h.score.toFixed(3)}</span>}
          </div>
        ))}
        {hits && hits.length === 0 && <div className="sub">无命中。</div>}
      </section>

      {/* 浏览（按当前作用域 + 层） */}
      <section>
        <div className="sec-head">
          <span className="ico violet">
            <SparkIcon size={18} />
          </span>
          <div>
            <h3>
              记忆条目 · {scopeName}（{items.length}）
            </h3>
            <p className="hint">
              {isWorkspace
                ? "工作区记忆为本工程私有；删除该工作区会一并清除。"
                : "全局 markdown 文件可直接编辑，daemon 监听后自动回灌。"}
            </p>
          </div>
          {isWorkspace && (
            <button className="btn-sm mem-clear" onClick={() => void clearScope()} title="清空本工作区的私有记忆池">
              <TrashIcon size={13} /> 清空本工作区记忆
            </button>
          )}
        </div>
        <div className="mem-layers">
          {layerDefs.map((l) => (
            <button key={l.id} className={`kb-coll ${layer === l.id ? "on" : ""}`} onClick={() => setLayer(l.id)}>
              {l.label}
            </button>
          ))}
        </div>
        {items.length === 0 && <div className="sub">（暂无记忆）</div>}
        {items.map((m) => (
          <div key={m.id} className="mem-item">
            <span className="mem-layer">{LAYER_LABEL[m.layer] ?? m.layer}</span>
            {editing?.id === m.id ? (
              <>
                <textarea
                  className="mem-edit"
                  rows={2}
                  value={editing.text}
                  onChange={(e) => setEditing({ id: m.id, text: e.target.value })}
                  autoFocus
                />
                <button className="mem-act save" title="保存" onClick={() => void saveEdit()}>
                  <CheckIcon size={14} />
                </button>
                <button className="mem-act" title="取消" onClick={() => setEditing(null)}>
                  ×
                </button>
              </>
            ) : (
              <>
                <span className="mem-text">{m.text}</span>
                <button className="mem-act" title="编辑" onClick={() => setEditing({ id: m.id, text: m.text })}>
                  <EditIcon size={14} />
                </button>
                <button className="mem-act del" title="删除" onClick={() => void del(m.id)}>
                  <TrashIcon size={14} />
                </button>
              </>
            )}
          </div>
        ))}
      </section>
    </div>
  );
}
