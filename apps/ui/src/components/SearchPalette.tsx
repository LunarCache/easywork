import { useEffect, useMemo, useRef, useState } from "react";
import type { Project } from "@ew/shared";
import { SearchIcon, NewChatIcon, FolderClosedIcon } from "../icons.js";

interface ThreadItem {
  id: string;
  title: string;
  updatedAt: string;
  projectId?: string;
}

type Result =
  | { kind: "chat"; id: string; title: string; sub: string }
  | { kind: "work"; id: string; projectId: string; title: string; sub: string }
  | { kind: "project"; id: string; title: string; sub: string };

/** 全局搜索 / 快速切换（⌘K）：跨 对话 / 工作区 / 工作区会话 模糊匹配，回车跳转。 */
export function SearchPalette({
  threads,
  projects,
  onSelectThread,
  onSelectWorkThread,
  onSelectProject,
  onClose,
}: {
  threads: ThreadItem[];
  projects: Project[];
  onSelectThread: (id: string) => void;
  onSelectWorkThread: (pid: string, tid: string) => void;
  onSelectProject: (id: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const projName = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projects) m.set(p.id, p.name);
    return m;
  }, [projects]);

  const results = useMemo<Result[]>(() => {
    const needle = q.trim().toLowerCase();
    const hit = (s: string) => !needle || s.toLowerCase().includes(needle);
    const out: Result[] = [];
    for (const p of projects) {
      if (hit(p.name)) out.push({ kind: "project", id: p.id, title: p.name, sub: "工作区" });
    }
    for (const t of threads) {
      const title = t.title || "新会话";
      if (t.projectId) {
        const pn = projName.get(t.projectId) ?? "工作区";
        if (hit(title) || hit(pn)) out.push({ kind: "work", id: t.id, projectId: t.projectId, title, sub: pn });
      } else if (hit(title)) {
        out.push({ kind: "chat", id: t.id, title, sub: "对话" });
      }
    }
    return out.slice(0, 50);
  }, [q, threads, projects, projName]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    setIdx(0);
  }, [q]);

  const choose = (r: Result | undefined) => {
    if (!r) return;
    if (r.kind === "chat") onSelectThread(r.id);
    else if (r.kind === "work") onSelectWorkThread(r.projectId, r.id);
    else onSelectProject(r.id);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setIdx((i) => (results.length ? (i + 1) % results.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIdx((i) => (results.length ? (i - 1 + results.length) % results.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(results[idx]);
    }
  };

  return (
    <div className="search-overlay" data-testid="search-overlay" onMouseDown={onClose}>
      <div className="search-box" data-testid="search-box" onMouseDown={(e) => e.stopPropagation()}>
        <div className="search-head">
          <SearchIcon size={16} className="search-head-ico" />
          <input
            ref={inputRef}
            className="search-input"
            data-testid="search-input"
            placeholder="搜索对话、工作区…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <span className="search-esc">esc</span>
        </div>
        <div className="search-results" data-testid="search-results" role="listbox">
          {results.length === 0 ? (
            <div className="search-empty" data-testid="search-empty">无匹配结果</div>
          ) : (
            results.map((r, i) => (
              <button
                key={`${r.kind}:${r.id}`}
                className={`search-item ${i === idx ? "on" : ""}`}
                data-testid={`search-item-${r.kind}-${r.id}`}
                onMouseEnter={() => setIdx(i)}
                onClick={() => choose(r)}
              >
                {r.kind === "project" || r.kind === "work" ? (
                  <FolderClosedIcon size={15} className="search-item-ico" />
                ) : (
                  <NewChatIcon size={15} className="search-item-ico" />
                )}
                <span className="search-item-title">{r.title}</span>
                <span className="search-item-sub">{r.sub}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
