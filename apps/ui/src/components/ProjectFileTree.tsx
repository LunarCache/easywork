import { useEffect, useState, type ReactElement } from "react";
import type { WsEntry } from "@ew/sdk";
import { getClient } from "../lib/client.js";
import { fileType } from "../lib/filetype.js";
import { ChevronIcon, FolderClosedIcon, FolderIcon } from "../icons.js";

/**
 * 项目目录懒加载树：每展开一层向 daemon 取 `wsList(pid, dir, 1)`，按需深入。
 * 点文件 → onOpenFile(相对路径)，由上层在右侧「工作台坞」打开。
 */
export function ProjectFileTree({
  projectId,
  onOpenFile,
  activePath,
}: {
  projectId: string;
  onOpenFile: (path: string) => void;
  activePath?: string | null;
}) {
  // children[dir] = 该目录下的条目（"" 为根）；expanded = 已展开目录集合。
  const [children, setChildren] = useState<Record<string, WsEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState<Set<string>>(new Set());

  const load = async (dir: string) => {
    setLoading((s) => new Set(s).add(dir));
    try {
      const entries = await getClient().wsList(projectId, dir || ".", 1);
      setChildren((c) => ({ ...c, [dir]: entries }));
    } catch {
      setChildren((c) => ({ ...c, [dir]: [] }));
    } finally {
      setLoading((s) => {
        const n = new Set(s);
        n.delete(dir);
        return n;
      });
    }
  };

  useEffect(() => {
    setChildren({});
    setExpanded(new Set());
    void load("");
  }, [projectId]);

  const toggleDir = (path: string) => {
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(path)) n.delete(path);
      else {
        n.add(path);
        if (!(path in children)) void load(path);
      }
      return n;
    });
  };

  const renderDir = (dir: string, depth: number): ReactElement[] => {
    const entries = children[dir];
    if (!entries) return [];
    const rows: ReactElement[] = [];
    for (const e of entries) {
      const name = e.path.split("/").pop() || e.path;
      const pad = 6 + depth * 12;
      if (e.type === "dir") {
        const open = expanded.has(e.path);
        rows.push(
          <button
            key={e.path}
            className="ad-ft-row"
            style={{ paddingLeft: pad }}
            onClick={() => toggleDir(e.path)}
            title={e.path}
          >
            <ChevronIcon size={11} className={`ad-ft-chev ${open ? "open" : ""}`} />
            {open ? <FolderIcon size={13} className="ad-ft-ico" /> : <FolderClosedIcon size={13} className="ad-ft-ico" />}
            <span className="ad-ft-name">{name}</span>
          </button>,
        );
        if (open) rows.push(...renderDir(e.path, depth + 1));
      } else {
        rows.push(
          <button
            key={e.path}
            className={`ad-ft-row file ${activePath === e.path ? "on" : ""}`}
            style={{ paddingLeft: pad + 13 }}
            onClick={() => onOpenFile(e.path)}
            title={e.path}
          >
            {(() => {
              const ft = fileType(e.path);
              return <ft.Icon size={12} className="ad-ft-ico" style={{ color: ft.color }} />;
            })()}
            <span className="ad-ft-name">{name}</span>
          </button>,
        );
      }
    }
    return rows;
  };

  const root = children[""];
  return (
    <div className="ad-ft">
      {root == null ? (
        <div className="ad-ft-hint">{loading.has("") ? "载入中…" : ""}</div>
      ) : root.length === 0 ? (
        <div className="ad-ft-hint">空目录</div>
      ) : (
        renderDir("", 0)
      )}
    </div>
  );
}
