import { useCallback, useEffect, useRef, useState } from "react";
import { getClient } from "../lib/client.js";
import { KbIcon, FileIcon, SearchIcon, TrashIcon, UploadIcon, LoaderIcon, CheckIcon, XIcon } from "../icons.js";

interface KbJob {
  id: string;
  source: string;
  kbId: string;
  status: string;
  chunks?: number;
  done?: number;
  total?: number;
  error?: string;
}

function toBase64(ab: ArrayBuffer): string {
  const bytes = new Uint8Array(ab);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}

const STATUS_LABEL: Record<string, string> = {
  queued: "排队中",
  parsing: "解析中",
  embedding: "嵌入中",
  done: "完成",
  error: "失败",
};

interface KbDoc {
  id: string;
  kbId: string;
  source: string;
  chunks: number;
  createdAt: string;
}

export function KnowledgeBase() {
  const [kbs, setKbs] = useState<{ kbId: string; docs: number; chunks: number }[]>([]);
  const [docs, setDocs] = useState<KbDoc[]>([]);
  const [totalChunks, setTotalChunks] = useState(0);
  const [active, setActive] = useState<string | undefined>(undefined); // undefined = 全部
  const [kbId, setKbId] = useState("default"); // 上传目标集合
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<{ text: string; source: string; score: number }[] | null>(null);
  const [jobs, setJobs] = useState<KbJob[]>([]);
  const [polling, setPolling] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const c = getClient();
    try {
      const [list, d] = await Promise.all([c.kbList(), c.kbDocs(active)]);
      setKbs(list.kbs);
      setDocs(d.docs);
      setTotalChunks(d.chunks);
    } catch {
      /* ignore */
    }
  }, [active]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 异步上传任务轮询：有进行中的任务时每 ~900ms 拉一次，全部完成则刷新文档列表。
  useEffect(() => {
    if (!polling) return;
    const id = setInterval(async () => {
      try {
        const r = await getClient().kbJobs();
        setJobs(r.jobs);
        const active = r.jobs.some((j) => ["queued", "parsing", "embedding"].includes(j.status));
        if (!active) {
          setPolling(false);
          void refresh();
        }
      } catch {
        /* ignore */
      }
    }, 900);
    return () => clearInterval(id);
  }, [polling, refresh]);

  const onFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const target = kbId.trim() || "default";
    for (const f of Array.from(files)) {
      try {
        const b64 = toBase64(await f.arrayBuffer());
        await getClient().kbUpload({ source: f.name, contentBase64: b64, kbId: target });
      } catch {
        /* 单文件失败不阻断其它 */
      }
    }
    setPolling(true);
    // 立即拉一次以显示排队状态
    void getClient()
      .kbJobs()
      .then((r) => setJobs(r.jobs))
      .catch(() => {});
  };

  const del = async (id: string) => {
    await getClient().kbDeleteDoc(id);
    await refresh();
  };

  const search = async () => {
    if (!query.trim()) return;
    const r = await getClient().kbSearch(query.trim());
    setHits(r.hits);
  };

  return (
    <div className="page kb-page">
      <div className="page-head">
        <span className="ico">
          <KbIcon size={20} />
        </span>
        <div>
          <h2>知识库</h2>
          <p className="lead">上传文档（txt / markdown），分块嵌入后供模型检索（RRF 混合）。聊天里开「知识库」即用。</p>
        </div>
      </div>
      {/* 集合筛选 */}
      <div className="kb-collections">
        <button className={`kb-coll ${!active ? "on" : ""}`} onClick={() => setActive(undefined)}>
          全部 <small>{totalChunks && !active ? `${docs.length} 文档` : ""}</small>
        </button>
        {kbs.map((k) => (
          <button key={k.kbId} className={`kb-coll ${active === k.kbId ? "on" : ""}`} onClick={() => setActive(k.kbId)}>
            {k.kbId} <small>{k.docs} 文档 · {k.chunks} 片段</small>
          </button>
        ))}
      </div>

      <div className="kb-cols">
        {/* 上传 */}
        <section className="kb-upload">
          <h3>上传文档</h3>
          <label className="kb-field">
            <span>目标集合</span>
            <input placeholder="default / 产品库 …" value={kbId} onChange={(e) => setKbId(e.target.value)} />
          </label>

          {/* 本地文件上传：拖拽或点击，后台异步解析+嵌入 */}
          <div
            className={`kb-drop ${dragOver ? "over" : ""}`}
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              void onFiles(e.dataTransfer.files);
            }}
          >
            <UploadIcon size={24} />
            <p>拖拽文件到此，或点击选择</p>
            <span>支持 txt / md / csv / json / 代码等文本文件（可多选），后台异步解析</span>
            <input
              ref={fileRef}
              type="file"
              multiple
              style={{ display: "none" }}
              onChange={(e) => {
                void onFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </div>

          {jobs.length > 0 && (
            <div className="kb-jobs">
              {jobs.map((j) => {
                const pct =
                  j.status === "done"
                    ? 100
                    : j.status === "embedding" && j.total
                      ? Math.round(((j.done ?? 0) / j.total) * 100)
                      : j.status === "parsing" || j.status === "queued"
                        ? 0
                        : 0;
                const showBar = j.status === "embedding" || j.status === "parsing" || j.status === "queued";
                return (
                  <div key={j.id} className={`kb-job ${j.status}`}>
                    <div className="kb-job-top">
                      {j.status === "done" ? (
                        <CheckIcon size={14} />
                      ) : j.status === "error" ? (
                        <XIcon size={14} className="kb-job-x" />
                      ) : (
                        <LoaderIcon size={14} className="spin" />
                      )}
                      <span className="kb-job-name">{j.source}</span>
                      <span className="kb-job-status">
                        {STATUS_LABEL[j.status] ?? j.status}
                        {j.status === "embedding" && j.total ? ` ${j.done ?? 0}/${j.total}` : ""}
                        {j.status === "done" && j.chunks != null ? ` · ${j.chunks} 片段` : ""}
                        {j.status === "error" && j.error ? ` · ${j.error}` : ""}
                      </span>
                    </div>
                    {showBar && (
                      <div className="kb-job-track">
                        <div className={`kb-job-fill ${pct === 0 ? "indet" : ""}`} style={{ width: `${pct}%` }} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <h3 style={{ marginTop: 20 }}>检索预览</h3>
          <div className="row" style={{ maxWidth: "none", marginBottom: 10 }}>
            <div className="field">
              <SearchIcon size={16} />
              <input
                placeholder="测试检索（跨全部集合）"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void search()}
              />
            </div>
            <button onClick={() => void search()}>检索</button>
          </div>
          {hits?.map((h, i) => (
            <div key={i} className="kb-hit">
              <div className="kb-hit-head">
                <b>[{i + 1}]</b> {h.source} <span className="kb-score">{h.score.toFixed(3)}</span>
              </div>
              <div className="kb-hit-text">{h.text.slice(0, 280)}{h.text.length > 280 ? "…" : ""}</div>
            </div>
          ))}
          {hits && hits.length === 0 && <div className="sub">无命中。</div>}
        </section>

        {/* 文档列表 */}
        <section className="kb-docs">
          <h3>文档（{active ?? "全部"}）· {docs.length}</h3>
          {docs.length === 0 && (
            <div className="empty-models">
              <FileIcon size={26} />
              <p>还没有文档</p>
              <span>在左侧上传一篇 txt / markdown 即可。</span>
            </div>
          )}
          {docs.map((d) => (
            <div key={d.id} className="kb-doc">
              <span className="kb-doc-glyph">
                <FileIcon size={16} />
              </span>
              <div className="kb-doc-body">
                <div className="kb-doc-name">{d.source}</div>
                <div className="kb-doc-meta">
                  <span className="kb-coll-tag">{d.kbId}</span> · {d.chunks} 片段
                </div>
              </div>
              <button className="kb-doc-del" title="删除" onClick={() => void del(d.id)}>
                <TrashIcon size={14} />
              </button>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
