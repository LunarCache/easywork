// 统一文件预览组件：一个 <FileViewer source>，按 kind 选渲染器（开闭：加类型 = 加一个分支）。
// 数据源四态：fs（dock 文件，走 /files/meta + /files/raw）/ text（已有文本）/ url（网页工件）/ bytes（消息图片）。
import { useCallback, useEffect, useMemo, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import hljs from "highlight.js/lib/common";
import { getClient } from "../lib/client.js";
import { resolvePreviewKind, mimeForName, extOf, langForExt, useBlobUrl, type PreviewKind, type PreviewMeta } from "../lib/preview.js";
import { fileType, formatFileSize } from "../lib/filetype.js";
import { ArrowLeftIcon, LoaderIcon, CopyIcon, CheckIcon } from "../icons.js";

export type PreviewSource =
  | { kind: "fs"; scope: "workspace" | "chat"; id: string; path: string }
  | { kind: "text"; name: string; text: string }
  | { kind: "url"; url: string }
  | { kind: "bytes"; name: string; mime: string; data: string }; // data = base64

function CodeBody({ text, name }: { text: string; name: string }) {
  const html = useMemo(() => {
    const lang = langForExt(extOf(name));
    try {
      return lang && hljs.getLanguage(lang)
        ? hljs.highlight(text, { language: lang, ignoreIllegals: true }).value
        : hljs.highlightAuto(text).value;
    } catch {
      return text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
    }
  }, [text, name]);
  return (
    <pre className="fv-code">
      <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  );
}

function CopyBtn({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="fv-btn"
      title="复制"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
    >
      {done ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
    </button>
  );
}

/** 统一文件预览。 */
export function FileViewer({ source, onBack }: { source: PreviewSource; onBack?: () => void }) {
  const [meta, setMeta] = useState<PreviewMeta | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // markdown/html/svg：在"渲染"与"源码"间切换。
  const [raw, setRaw] = useState(false);

  // 稳定 key：父级每次渲染都新建 source 对象，故 effect 依赖派生 key 字符串而非对象，避免反复重取。
  const srcKey =
    source.kind === "fs"
      ? `fs:${source.scope}:${source.id}:${source.path}`
      : source.kind === "text"
        ? `text:${source.name}:${source.text.length}`
        : source.kind === "url"
          ? `url:${source.url}`
          : `bytes:${source.name}`;

  // —— 解析 meta（fs 走后端；其余本地合成） ——
  useEffect(() => {
    setRaw(false);
    setErr(null);
    if (source.kind === "fs") {
      setMeta(null);
      let alive = true;
      getClient()
        .previewMeta(source.scope, source.id, source.path)
        .then((m) => alive && setMeta(m))
        .catch((e) => alive && setErr(e instanceof Error ? e.message : String(e)));
      return () => {
        alive = false;
      };
    }
    if (source.kind === "text") {
      setMeta({ name: source.name, mime: mimeForName(source.name), kind: resolvePreviewKind(source.name), size: source.text.length, text: source.text });
    } else if (source.kind === "bytes") {
      setMeta({ name: source.name, mime: source.mime, kind: resolvePreviewKind(source.name), size: 0 });
    } else if (source.kind === "url") {
      setMeta({ name: source.url, mime: "text/html", kind: "html", size: 0 });
    }
    return;
  }, [srcKey]);

  // —— 媒体类（fs 的 image/pdf）取字节 blob —— hook 必须无条件调用，故 key 为 null 时不取。
  const blobKey =
    source.kind === "fs" && meta && (meta.kind === "image" || meta.kind === "pdf" || meta.kind === "binary")
      ? `${source.scope}:${source.id}:${source.path}`
      : null;
  const fetchBytes = useCallback(() => {
    if (source.kind !== "fs") return Promise.reject(new Error("no-bytes"));
    return getClient().fileBytes(source.scope, source.id, source.path);
  }, [source]);
  const blob = useBlobUrl(blobKey, fetchBytes);

  if (err) return <div className="fv-msg fv-err">无法预览 · {err}</div>;
  if (!meta) return <div className="fv-msg"><LoaderIcon size={18} className="spin" /></div>;

  const ft = fileType(meta.name);
  const kind: PreviewKind = meta.kind;
  const text = meta.text ?? "";
  const toggleable = kind === "markdown" || kind === "html" || kind === "svg";

  // bytes 源的 image：data URL；fs 源：blob URL。
  const imgSrc = source.kind === "bytes" ? `data:${source.mime};base64,${source.data}` : blob.url;

  return (
    <div className="fv" data-testid="file-viewer">
      <div className="fv-bar">
        {onBack && (
          <button className="fv-btn" title="返回文件列表" aria-label="返回文件列表" onClick={onBack}>
            <ArrowLeftIcon size={15} />
          </button>
        )}
        <span className="fv-badge" style={{ background: ft.color }}>{ft.label}</span>
        <span className="fv-name" data-testid="file-viewer-name" title={meta.name}>{meta.name.split(/[/\\]/).pop()}</span>
        {meta.size > 0 && <span className="fv-size">{formatFileSize(meta.size)}</span>}
        <span className="fv-spacer" />
        {toggleable && (
          <div className="fv-seg">
            <button className={!raw ? "on" : ""} onClick={() => setRaw(false)}>预览</button>
            <button className={raw ? "on" : ""} onClick={() => setRaw(true)}>源码</button>
          </div>
        )}
        {text && <CopyBtn text={text} />}
        {blob.url && (
          <a className="fv-btn" href={blob.url} download={meta.name.split(/[/\\]/).pop()} title="下载">↓</a>
        )}
      </div>

      <div className="fv-body">
        {/* —— 文本 / 代码 —— */}
        {(kind === "text" || kind === "code") && <CodeBody text={text} name={meta.name} />}

        {/* —— Markdown —— */}
        {kind === "markdown" && (raw
          ? <CodeBody text={text} name={meta.name} />
          : <div className="fv-md md"><Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>{text || "（空文档）"}</Markdown></div>)}

        {/* —— HTML —— */}
        {kind === "html" && source.kind !== "url" && (raw
          ? <CodeBody text={text} name={meta.name} />
          : <iframe className="fv-frame" sandbox="allow-scripts" title={meta.name} srcDoc={text} />)}

        {/* —— 网页 URL —— */}
        {kind === "html" && source.kind === "url" && (
          <iframe className="fv-frame" sandbox="allow-scripts allow-same-origin" title="预览" src={source.url} />
        )}

        {/* —— SVG —— */}
        {kind === "svg" && (raw
          ? <CodeBody text={text} name={meta.name} />
          : <div className="fv-img checker"><img alt={meta.name} src={`data:image/svg+xml;utf8,${encodeURIComponent(text)}`} /></div>)}

        {/* —— 图片 —— */}
        {kind === "image" && (
          blob.loading && source.kind === "fs"
            ? <div className="fv-msg"><LoaderIcon size={18} className="spin" /></div>
            : blob.error
              ? <div className="fv-msg fv-err">图片加载失败</div>
              : imgSrc
                ? <div className="fv-img checker"><img alt={meta.name} src={imgSrc} /></div>
                : <div className="fv-msg"><LoaderIcon size={18} className="spin" /></div>
        )}

        {/* —— PDF —— */}
        {kind === "pdf" && (
          blob.loading
            ? <div className="fv-msg"><LoaderIcon size={18} className="spin" /></div>
            : blob.error || !blob.url
              ? <div className="fv-msg fv-err">PDF 加载失败</div>
              : <iframe className="fv-frame" title={meta.name} src={blob.url} />
        )}

        {/* —— 二进制兜底 —— */}
        {kind === "binary" && (
          <div className="fv-msg fv-bin">
            二进制文件，无法预览 · {formatFileSize(meta.size)}
            {blob.url && (
              <a className="fv-dl" href={blob.url} download={meta.name.split(/[/\\]/).pop()}>下载</a>
            )}
          </div>
        )}

        {meta.truncated && <div className="fv-trunc">内容较大，已截断显示。</div>}
      </div>
    </div>
  );
}
