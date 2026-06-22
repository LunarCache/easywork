import { useCallback, useEffect, useRef, useState } from "react";
import { getClient } from "../lib/client.js";
import { BookIcon, UploadIcon, TrashIcon, XIcon, LoaderIcon } from "../icons.js";

interface KbDoc {
  id: string;
  kbId: string;
  source: string;
  chunks: number;
  createdAt: string;
}
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
interface DocContent {
  id: string;
  kbId: string;
  source: string;
  createdAt: string;
  chunks: number;
  text: string;
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

/** 文件类型角标（颜色按扩展名，呼应参考设计的 MD/PDF/XLS/TXT 彩色徽章）。 */
function fileBadge(source: string): { label: string; color: string } {
  const ext = (source.split(".").pop() || "").toLowerCase();
  const map: Record<string, { label: string; color: string }> = {
    md: { label: "MD", color: "#3B6FE0" },
    markdown: { label: "MD", color: "#3B6FE0" },
    pdf: { label: "PDF", color: "#E0524F" },
    xls: { label: "XLS", color: "#1E9E58" },
    xlsx: { label: "XLS", color: "#1E9E58" },
    csv: { label: "CSV", color: "#1E9E58" },
    txt: { label: "TXT", color: "#8A919C" },
    json: { label: "JSON", color: "#B5640A" },
    html: { label: "HTML", color: "#B5640A" },
  };
  return map[ext] ?? { label: ext ? ext.slice(0, 4).toUpperCase() : "DOC", color: "#6B7280" };
}

function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

/** 知识库浮层：集合导航 + 文档列表 + 文档预览 + 上传。 */
export function KnowledgeBaseOverlay({ onClose }: { onClose: () => void }) {
  const [kbs, setKbs] = useState<{ kbId: string; docs: number; chunks: number }[]>([]);
  const [docs, setDocs] = useState<KbDoc[]>([]);
  const [totalChunks, setTotalChunks] = useState(0);
  const [active, setActive] = useState<string | undefined>(undefined); // undefined = 全部
  const [sel, setSel] = useState<string | null>(null);
  const [content, setContent] = useState<DocContent | null>(null);
  const [jobs, setJobs] = useState<KbJob[]>([]);
  const [polling, setPolling] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const [list, d] = await Promise.all([getClient().kbList(), getClient().kbDocs(active)]);
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

  useEffect(() => {
    if (!polling) return;
    const id = setInterval(async () => {
      try {
        const r = await getClient().kbJobs();
        setJobs(r.jobs);
        if (!r.jobs.some((j) => ["queued", "parsing", "embedding"].includes(j.status))) {
          setPolling(false);
          void refresh();
        }
      } catch {
        /* ignore */
      }
    }, 900);
    return () => clearInterval(id);
  }, [polling, refresh]);

  const openDoc = async (id: string) => {
    setSel(id);
    setContent(null);
    try {
      const { doc } = await getClient().kbDocContent(id);
      setContent(doc);
    } catch {
      setContent(null);
    }
  };

  const onFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const target = active || "default";
    for (const f of Array.from(files)) {
      try {
        await getClient().kbUpload({ source: f.name, contentBase64: toBase64(await f.arrayBuffer()), kbId: target });
      } catch {
        /* 单文件失败不阻断 */
      }
    }
    setPolling(true);
    void getClient()
      .kbJobs()
      .then((r) => setJobs(r.jobs))
      .catch(() => {});
  };

  const del = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await getClient().kbDeleteDoc(id);
    if (sel === id) {
      setSel(null);
      setContent(null);
    }
    await refresh();
  };

  const activeJobs = jobs.filter((j) => ["queued", "parsing", "embedding"].includes(j.status));

  return (
    <div className="ad-overlay" onClick={onClose}>
      <div className="ad-overlay-card kb-ov-card" onClick={(e) => e.stopPropagation()}>
        <div className="ad-ov-head kb-ov-head">
          <span className="kb-ov-ico">
            <BookIcon size={18} />
          </span>
          <div className="kb-ov-titles">
            <span className="ad-ov-title">知识库</span>
            <span className="kb-ov-sub">{totalChunks} 片段已索引</span>
          </div>
          <span className="ad-spacer" />
          <button className="kb-ov-upload" onClick={() => fileRef.current?.click()}>
            <UploadIcon size={15} /> 上传
          </button>
          <button className="ad-ov-close" title="关闭" onClick={onClose}>
            <XIcon size={15} />
          </button>
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

        <div className="kb-ov-body">
          {/* 集合导航 */}
          <div className="kb-ov-colls">
            <div className="kb-ov-colls-h">集合</div>
            <button className={`kb-ov-coll ${!active ? "on" : ""}`} onClick={() => setActive(undefined)}>
              <span className="kb-ov-coll-name">全部文档</span>
              <span className="kb-ov-coll-n">{kbs.reduce((n, k) => n + k.docs, 0)}</span>
            </button>
            {kbs.map((k) => (
              <button
                key={k.kbId}
                className={`kb-ov-coll ${active === k.kbId ? "on" : ""}`}
                onClick={() => setActive(k.kbId)}
              >
                <span className="kb-ov-coll-name">{k.kbId}</span>
                <span className="kb-ov-coll-n">{k.docs}</span>
              </button>
            ))}
          </div>

          {/* 文档列表 */}
          <div className="kb-ov-list">
            <div className="kb-ov-list-h">
              <span>{active ?? "全部文档"}</span>
              <span className="kb-ov-list-n">{docs.length} 个文档</span>
            </div>
            <div className="kb-ov-list-scroll">
              {activeJobs.map((j) => (
                <div key={j.id} className="kb-ov-doc job">
                  <span className="kb-ov-badge" style={{ background: fileBadge(j.source).color }}>
                    {fileBadge(j.source).label}
                  </span>
                  <div className="kb-ov-doc-body">
                    <div className="kb-ov-doc-name">{j.source}</div>
                    <div className="kb-ov-doc-meta">
                      <LoaderIcon size={11} className="spin" /> {STATUS_LABEL[j.status] ?? j.status}
                      {j.status === "embedding" && j.total ? ` ${j.done ?? 0}/${j.total}` : ""}
                    </div>
                  </div>
                </div>
              ))}
              {docs.length === 0 && activeJobs.length === 0 && (
                <div className="kb-ov-empty">
                  <BookIcon size={26} />
                  <p>还没有文档</p>
                  <span>点右上「上传」导入 md / pdf / txt 等文档。</span>
                </div>
              )}
              {docs.map((d) => {
                const b = fileBadge(d.source);
                return (
                  <button
                    key={d.id}
                    className={`kb-ov-doc ${sel === d.id ? "on" : ""}`}
                    onClick={() => void openDoc(d.id)}
                  >
                    <span className="kb-ov-badge" style={{ background: b.color }}>
                      {b.label}
                    </span>
                    <div className="kb-ov-doc-body">
                      <div className="kb-ov-doc-name">{d.source}</div>
                      <div className="kb-ov-doc-meta">
                        {d.chunks} 片段 · {relTime(d.createdAt)}
                      </div>
                    </div>
                    <span className="kb-ov-doc-del" title="删除" onClick={(e) => void del(d.id, e)}>
                      <TrashIcon size={14} />
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 文档预览 */}
          <div className="kb-ov-preview">
            {!sel ? (
              <div className="kb-ov-empty pad">
                <BookIcon size={28} />
                <p>选择一篇文档查看内容</p>
              </div>
            ) : !content ? (
              <div className="kb-ov-empty pad">
                <LoaderIcon size={20} className="spin" />
              </div>
            ) : (
              <>
                <div className="kb-ov-pv-head">
                  <span className="kb-ov-badge" style={{ background: fileBadge(content.source).color }}>
                    {fileBadge(content.source).label}
                  </span>
                  <div>
                    <div className="kb-ov-pv-name">{content.source}</div>
                    <div className="kb-ov-pv-meta">
                      {content.chunks} 片段 · {relTime(content.createdAt)} · {content.kbId}
                    </div>
                  </div>
                </div>
                <pre className="kb-ov-pv-body">{content.text || "（空文档）"}</pre>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
