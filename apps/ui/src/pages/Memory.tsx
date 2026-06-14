import { useCallback, useEffect, useState } from "react";
import type { MemoryLayer } from "@ew/shared";
import { getClient } from "../lib/client.js";
import { SparkIcon, SearchIcon, EditIcon, TrashIcon, CheckIcon } from "../icons.js";

interface MemItem {
  id: string;
  layer: string;
  text: string;
  sessionId?: string;
  updatedAt: string;
}

const LAYERS: { id: MemoryLayer | "all"; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "user-profile", label: "用户画像" },
  { id: "agent-memory", label: "助手记忆" },
  { id: "skills", label: "技能" },
];

export function Memory() {
  const [items, setItems] = useState<MemItem[]>([]);
  const [layer, setLayer] = useState<MemoryLayer | "all">("all");
  const [embStatus, setEmbStatus] = useState<{ ready: boolean; modelId?: string; dim: number } | null>(null);
  const [embBusy, setEmbBusy] = useState(false);
  const [note, setNote] = useState("");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<{ text: string; score?: number; layer: string }[] | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const c = getClient();
      setEmbStatus(await c.embeddingStatus());
      setItems(await c.listMemory(layer === "all" ? undefined : layer));
    } catch {
      /* ignore */
    }
  }, [layer]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
    setHits(await getClient().recallMemory(query.trim(), 6));
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

  return (
    <div className="page">
      <div className="page-head">
        <span className="ico">
          <SparkIcon size={20} />
        </span>
        <div>
          <h2>记忆</h2>
          <p className="lead">分层 markdown 为真相源 + 本地向量/词法混合召回。生成前自动召回注入、生成后抽取写入。</p>
        </div>
      </div>
      {note && <div className="note">{note}</div>}

      {/* 向量召回状态 */}
      <section>
        <div className="sec-head">
          <span className="ico green">
            <SparkIcon size={18} />
          </span>
          <div>
            <h3>向量召回</h3>
            <p className="hint">本地 CPU embedding（nomic-embed-text）。未启用时降级为纯词法召回。</p>
          </div>
        </div>
        <div className="sub">
          状态：{embStatus?.ready ? `已启用（${embStatus.dim} 维 · ${embStatus.modelId}）` : "未启用（词法召回）"}
        </div>
        <button className="btn" style={{ marginTop: 8 }} onClick={() => void enableEmbedding()} disabled={embBusy || embStatus?.ready}>
          {embBusy ? "处理中…" : embStatus?.ready ? "已启用" : "启用向量召回（下载 nomic CPU 模型）"}
        </button>
      </section>

      {/* 召回测试 */}
      <section>
        <div className="sec-head">
          <span className="ico blue">
            <SearchIcon size={18} />
          </span>
          <div>
            <h3>召回测试</h3>
            <p className="hint">输入查询，查看混合召回命中与相关度分数。</p>
          </div>
        </div>
        <div className="row" style={{ maxWidth: 640 }}>
          <div className="field">
            <SearchIcon size={16} />
            <input placeholder="如：我养的宠物" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void recall()} />
          </div>
          <button onClick={() => void recall()}>召回</button>
        </div>
        {hits?.map((h, i) => (
          <div key={i} className="mem-hit">
            <span className="mem-layer">{h.layer}</span>
            {h.text}
            {h.score != null && <span className="mem-score">{h.score.toFixed(3)}</span>}
          </div>
        ))}
        {hits && hits.length === 0 && <div className="sub">无命中。</div>}
      </section>

      {/* 浏览 */}
      <section>
        <div className="sec-head">
          <span className="ico violet">
            <SparkIcon size={18} />
          </span>
          <div>
            <h3>记忆条目（{items.length}）</h3>
            <p className="hint">markdown 文件可直接编辑，daemon 监听后自动回灌。</p>
          </div>
        </div>
        <div className="mem-layers">
          {LAYERS.map((l) => (
            <button key={l.id} className={`kb-coll ${layer === l.id ? "on" : ""}`} onClick={() => setLayer(l.id)}>
              {l.label}
            </button>
          ))}
        </div>
        {items.length === 0 && <div className="sub">（该层暂无记忆）</div>}
        {items.map((m) => (
          <div key={m.id} className="mem-item">
            <span className="mem-layer">{m.layer}</span>
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
