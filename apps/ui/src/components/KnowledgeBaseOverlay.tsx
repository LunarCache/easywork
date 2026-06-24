import { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { getClient } from "../lib/client.js";
import { fileType, type FileTypeInfo } from "../lib/filetype.js";
import {
  BookIcon,
  UploadIcon,
  TrashIcon,
  XIcon,
  LoaderIcon,
  PlusIcon,
  KbIcon,
  MaximizeIcon,
  ArrowLeftIcon,
  CheckIcon,
} from "../icons.js";

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

const ACTIVE = ["queued", "parsing", "embedding"];

/** 文件类型角标 = 统一文件类型体系（见 lib/filetype）。 */
const fileBadge = fileType;
const isMarkdown = (source: string) => /\.(md|markdown|mdx)$/i.test(source);

/** 集合主导文件类型：取集合内最多的扩展名对应的角标（空集合返回 null → 用中性集合图标）。 */
function dominantType(sources: string[]): FileTypeInfo | null {
  if (sources.length === 0) return null;
  const tally = new Map<string, { info: FileTypeInfo; n: number }>();
  for (const s of sources) {
    const info = fileType(s);
    const e = tally.get(info.label) ?? { info, n: 0 };
    e.n++;
    tally.set(info.label, e);
  }
  return [...tally.values()].sort((a, b) => b.n - a.n)[0]!.info;
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

/**
 * 知识库页：左集合栏（常驻，默认选第一个集合）+ 右文档卡片网格（角标 + 文件名 + 片段数·时间）；
 * 文档区头部内置前端文件名搜索（输入即过滤）。点卡片从右侧滑出预览（md 渲染 / 其余纯文本）。
 */
export function KnowledgeBaseOverlay({ onClose, embedded }: { onClose?: () => void; embedded?: boolean }) {
  const [kbs, setKbs] = useState<{ kbId: string; docs: number; chunks: number }[]>([]);
  const [allDocs, setAllDocs] = useState<KbDoc[]>([]);
  const [totalChunks, setTotalChunks] = useState(0);
  const [selectedKb, setSelectedKb] = useState<string | undefined>(undefined); // 当前选中/上传目标集合
  const [q, setQ] = useState(""); // 前端搜索（仅文件名）
  const [sel, setSel] = useState<string | null>(null);
  const [content, setContent] = useState<DocContent | null>(null);
  const [maxed, setMaxed] = useState(false);
  const [jobs, setJobs] = useState<KbJob[]>([]);
  const [polling, setPolling] = useState(false);
  // 本地新建但尚无文档的集合（上传第一篇文档后由后端 kbList 接管）。
  const [extraKbs, setExtraKbs] = useState<string[]>([]);
  const [creating, setCreating] = useState(false); // 新建集合的行内输入（Tauri webview 无 window.prompt）
  const [newName, setNewName] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  // 一次取全部文档（含 kbId）→ 客户端分组算每集合计数 / 主导类型 / 文档列表，避免按集合多次请求。
  const refresh = useCallback(async () => {
    try {
      const [list, all] = await Promise.all([getClient().kbList(), getClient().kbDocs()]);
      setKbs(list.kbs);
      setAllDocs(all.docs);
      setTotalChunks(all.chunks);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!polling) return;
    const id = setInterval(async () => {
      try {
        const r = await getClient().kbJobs();
        setJobs(r.jobs);
        if (!r.jobs.some((j) => ACTIVE.includes(j.status))) {
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
  const closePreview = () => {
    setSel(null);
    setContent(null);
    setMaxed(false);
  };

  const onFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const target = currentKb || "default";
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
    if (sel === id) closePreview();
    await refresh();
  };

  const newColl = () => {
    setNewName("");
    setCreating(true);
  };
  const cancelColl = () => {
    setCreating(false);
    setNewName("");
  };
  const confirmColl = () => {
    // 规范化为合法 kbId：转小写、非 [a-z0-9-] 折成连字符、去首尾连字符。
    const id = newName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!id) return; // 空名：保持输入态
    if (!kbs.some((k) => k.kbId === id) && !extraKbs.includes(id)) setExtraKbs((cur) => [...cur, id]);
    setSelectedKb(id); // 选中并成为上传目标
    setQ(""); // 切集合清空搜索
    closePreview();
    setCreating(false);
    setNewName("");
  };

  const activeJobs = jobs.filter((j) => ACTIVE.includes(j.status));
  // 集合全集 = 后端集合 ∪ 本地新建 ∪ 有处理中任务的集合（新集合首传时其 job 的 kbId 可能尚未进 kbs）。
  const collIds = [
    ...new Set<string>([...kbs.map((k) => k.kbId), ...extraKbs, ...activeJobs.map((j) => j.kbId)]),
  ];
  // 无选中集合时默认选第一个（去掉「全部文档」入口，集合为唯一组织维度）。
  const currentKb = selectedKb ?? collIds[0];
  // 当前集合文档 + 处理中任务。
  const collDocs = currentKb ? allDocs.filter((d) => d.kbId === currentKb) : [];
  const jobsHere = currentKb ? activeJobs.filter((j) => j.kbId === currentKb) : [];
  // 前端搜索：仅按文件名（大小写不敏感），输入即过滤。
  const needle = q.trim().toLowerCase();
  const filteredDocs = needle ? collDocs.filter((d) => d.source.toLowerCase().includes(needle)) : collDocs;

  return (
    <div className={embedded ? "ad-page-embed" : "ad-overlay"} onClick={embedded ? undefined : onClose}>
      <div className={`ad-overlay-card kb-ov-card ${embedded ? "embed" : ""}`} onClick={(e) => e.stopPropagation()}>
        <div className="ad-ov-head kb-ov-head">
          <span className="kb-ov-ico">
            <BookIcon size={18} />
          </span>
          <div className="kb-ov-titles">
            <span className="ad-ov-title">知识库</span>
            <span className="kb-ov-sub">
              {totalChunks} 片段已索引{activeJobs.length > 0 ? ` · ${activeJobs.length} 处理中` : ""}
            </span>
          </div>
          <span className="ad-spacer" />
          <button className="kb-ov-newcoll" title="新建集合" onClick={newColl}>
            <PlusIcon size={15} /> 新建
          </button>
          <button
            className="kb-ov-upload"
            title={`上传到集合「${currentKb || "default"}」`}
            onClick={() => fileRef.current?.click()}
          >
            <UploadIcon size={15} /> 上传
          </button>
          {!embedded && (
            <button className="ad-ov-close" title="关闭" onClick={onClose}>
              <XIcon size={15} />
            </button>
          )}
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
          {/* 左：集合导航 */}
          <div className="kb-colls">
            <div className="kb-colls-h">集合</div>
            {creating && (
              <div className="kb-coll-new">
                <input
                  className="kb-coll-new-input"
                  autoFocus
                  placeholder="集合名（英文 / 数字 / 连字符）"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") confirmColl();
                    else if (e.key === "Escape") cancelColl();
                  }}
                />
                <button className="kb-pv-btn" title="创建" onClick={confirmColl}>
                  <CheckIcon size={15} />
                </button>
                <button className="kb-pv-btn" title="取消" onClick={cancelColl}>
                  <XIcon size={15} />
                </button>
              </div>
            )}
            {collIds.length === 0 && !creating && <div className="kb-colls-empty">还没有集合</div>}
            {collIds.map((id) => {
              const docs = allDocs.filter((d) => d.kbId === id);
              const ft = dominantType(docs.map((d) => d.source));
              const Icon = ft?.Icon ?? KbIcon;
              const isSel = currentKb === id;
              const procHere = activeJobs.some((j) => j.kbId === id);
              return (
                <button
                  key={id}
                  className={`kb-coll ${isSel ? "on" : ""}`}
                  onClick={() => {
                    setSelectedKb(id);
                    setQ("");
                  }}
                >
                  <span className="kb-coll-ico" style={{ background: ft?.color ?? "var(--accent)" }}>
                    <Icon size={14} />
                  </span>
                  <span className="kb-coll-name">{id}</span>
                  {procHere && <span className="kb-coll-proc" title="处理中" />}
                  <span className="kb-coll-n">{docs.length}</span>
                </button>
              );
            })}
          </div>

          {/* 右：文档区（标题 + 搜索 + 卡片网格） */}
          <div className="kb-docs">
            <div className="kb-docs-h">
              <span className="kb-docs-h-name">{currentKb ?? "—"}</span>
              <span className="kb-docs-h-n">· {filteredDocs.length} 文档</span>
              <div className="kb-search">
                <input placeholder="搜索文件名…" value={q} onChange={(e) => setQ(e.target.value)} />
              </div>
            </div>

            <div className="kb-doc-grid">
              {/* 处理中卡片 */}
              {jobsHere.map((j) => (
                <div key={j.id} className="kb-doc-card proc">
                  <div className="kb-doc-card-top">
                    <span className="kb-ov-badge" style={{ background: fileBadge(j.source).color }}>
                      {fileBadge(j.source).label}
                    </span>
                    <span className="kb-doc-card-name">{j.source}</span>
                  </div>
                  <div className="kb-proc-bar">
                    <div
                      className="kb-proc-fill"
                      style={
                        j.status === "embedding" && j.total
                          ? { width: `${Math.round(((j.done ?? 0) / j.total) * 100)}%` }
                          : { width: "35%", animation: "proc-indet 1.2s ease-in-out infinite" }
                      }
                    />
                  </div>
                  <div className="kb-doc-card-meta">
                    <LoaderIcon size={11} className="spin" /> {STATUS_LABEL[j.status] ?? j.status}
                    {j.status === "embedding" && j.total ? ` ${j.done ?? 0}/${j.total}` : ""}
                  </div>
                </div>
              ))}

              {/* 文档卡片 */}
              {filteredDocs.map((d) => {
                const b = fileBadge(d.source);
                return (
                  <button
                    key={d.id}
                    className={`kb-doc-card ${sel === d.id ? "on" : ""}`}
                    onClick={() => void openDoc(d.id)}
                  >
                    <div className="kb-doc-card-top">
                      <span className="kb-ov-badge" style={{ background: b.color }}>
                        {b.label}
                      </span>
                      <span className="kb-doc-card-name">{d.source}</span>
                      <span className="kb-doc-card-del" title="删除" onClick={(e) => void del(d.id, e)}>
                        <TrashIcon size={14} />
                      </span>
                    </div>
                    <div className="kb-doc-card-meta">
                      {d.chunks} 片段 · {relTime(d.createdAt)}
                    </div>
                  </button>
                );
              })}

              {/* 空态 */}
              {collDocs.length === 0 && jobsHere.length === 0 && !creating && (
                <div className="kb-ov-empty grid-empty">
                  <BookIcon size={26} />
                  <p>空集合</p>
                  <span>点右上「上传」导入文档到此集合。</span>
                </div>
              )}
              {collDocs.length > 0 && filteredDocs.length === 0 && (
                <div className="kb-ov-empty grid-empty">
                  <BookIcon size={22} />
                  <p>没有匹配「{q}」的文档</p>
                </div>
              )}
            </div>
          </div>

          {/* 文档预览（右侧滑出，复用工作台视觉） */}
          <div className={`kb-pv ${sel ? "open" : ""} ${maxed ? "max" : ""}`}>
            {sel && (
              <>
                <div className="kb-pv-top">
                  <button className="kb-pv-btn" title="返回" onClick={closePreview}>
                    <ArrowLeftIcon size={15} />
                  </button>
                  <span className="kb-pv-title">{content?.source ?? "…"}</span>
                  <span className="ad-spacer" />
                  <button className="kb-pv-btn" title={maxed ? "还原" : "放大"} onClick={() => setMaxed((m) => !m)}>
                    <MaximizeIcon size={14} />
                  </button>
                  <button className="kb-pv-btn" title="关闭" onClick={closePreview}>
                    <XIcon size={15} />
                  </button>
                </div>
                {!content ? (
                  <div className="kb-ov-empty pad">
                    <LoaderIcon size={20} className="spin" />
                  </div>
                ) : (
                  <>
                    <div className="kb-pv-meta">
                      <span className="kb-ov-badge sm" style={{ background: fileBadge(content.source).color }}>
                        {fileBadge(content.source).label}
                      </span>
                      <span>
                        {content.chunks} 片段 · {relTime(content.createdAt)} · {content.kbId}
                      </span>
                    </div>
                    {isMarkdown(content.source) ? (
                      <div className="kb-pv-body md">
                        <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                          {content.text || "（空文档）"}
                        </Markdown>
                      </div>
                    ) : (
                      <pre className="kb-pv-body pre">{content.text || "（空文档）"}</pre>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
