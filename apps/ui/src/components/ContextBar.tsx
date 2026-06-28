import { useState, type ReactNode } from "react";
import type { Project } from "@ew/shared";
import {
  FolderClosedIcon,
  GitBranchIcon,
  GitGraphIcon,
  FolderPlusIcon,
  SearchIcon,
  CheckIcon,
  ChevronDownIcon,
} from "../icons.js";

/**
 * 输入框上方的上下文条：项目 pill + 分支 pill，皆为可选择的下拉。
 * - 项目下拉：搜索 + 工作区列表（切换）+「打开文件夹」。
 * - 分支下拉：搜索 + 分支列表（切换，当前分支显示未提交改动数）+「Git 图谱」。
 */
export function ContextBar({
  project,
  projects,
  branch,
  branches,
  uncommitted,
  children,
  onSelectProject,
  onOpenFolder,
  onSwitchBranch,
  onOpenGitGraph,
}: {
  project: Project;
  projects: Project[];
  branch?: string;
  branches: string[];
  uncommitted: number;
  children?: ReactNode;
  onSelectProject: (id: string) => void;
  onOpenFolder: () => void;
  onSwitchBranch: (name: string) => void;
  onOpenGitGraph: () => void;
}) {
  const [open, setOpen] = useState<null | "project" | "branch">(null);
  const [q, setQ] = useState("");
  const close = () => {
    setOpen(null);
    setQ("");
  };
  const toggle = (m: "project" | "branch") => {
    setQ("");
    setOpen((cur) => (cur === m ? null : m));
  };

  const projMatch = projects.filter((p) => p.name.toLowerCase().includes(q.toLowerCase()));
  const brMatch = branches.filter((b) => b.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="composer-ctx">
      <div className="ctx-wrap">
        <button
          className={`composer-ctx-pill ${open === "project" ? "active" : ""}`}
          data-testid="workspace-project-pill"
          onClick={() => toggle("project")}
          title={project.workspaceDir}
        >
          <FolderClosedIcon size={14} />
          <span className="ctx-pill-name">{project.name}</span>
          <ChevronDownIcon size={12} className="ctx-pill-chev" />
        </button>
        {open === "project" && (
          <>
            <div className="menu-backdrop" onClick={close} />
            <div className="ctx-menu up" data-testid="workspace-project-menu">
              <div className="ctx-search">
                <SearchIcon size={14} />
                <input
                  autoFocus
                  data-testid="workspace-project-search"
                  placeholder="搜索工作区"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                />
              </div>
              <div className="ctx-list">
                {projMatch.map((p) => (
                  <button
                    key={p.id}
                    className={`ctx-item ${p.id === project.id ? "on" : ""}`}
                    data-testid={`workspace-project-option-${p.id}`}
                    onClick={() => {
                      onSelectProject(p.id);
                      close();
                    }}
                  >
                    <FolderClosedIcon size={15} className="ctx-item-ico" />
                    <span className="ctx-item-name">{p.name}</span>
                    {p.id === project.id && <CheckIcon size={15} className="ctx-item-check" />}
                  </button>
                ))}
                {projMatch.length === 0 && <div className="ctx-empty">无匹配工作区</div>}
              </div>
              <div className="ctx-sep" />
              <button
                className="ctx-item"
                onClick={() => {
                  onOpenFolder();
                  close();
                }}
              >
                <FolderPlusIcon size={15} className="ctx-item-ico" />
                <span className="ctx-item-name">打开文件夹</span>
              </button>
            </div>
          </>
        )}
      </div>

      {branch && (
        <div className="ctx-wrap">
          <button className={`composer-ctx-pill ${open === "branch" ? "active" : ""}`} onClick={() => toggle("branch")}>
            <GitBranchIcon size={14} />
            <span className="ctx-pill-name">{branch}</span>
            <ChevronDownIcon size={12} className="ctx-pill-chev" />
          </button>
          {open === "branch" && (
            <>
              <div className="menu-backdrop" onClick={close} />
              <div className="ctx-menu up">
                <div className="ctx-search">
                  <SearchIcon size={14} />
                  <input autoFocus placeholder="搜索分支" value={q} onChange={(e) => setQ(e.target.value)} />
                </div>
                <div className="ctx-eyebrow">分支</div>
                <div className="ctx-list">
                  {brMatch.map((b) => {
                    const cur = b === branch;
                    return (
                      <button
                        key={b}
                        className={`ctx-item br ${cur ? "on" : ""}`}
                        onClick={() => {
                          if (!cur) onSwitchBranch(b);
                          close();
                        }}
                      >
                        <GitBranchIcon size={15} className="ctx-item-ico" />
                        <div className="ctx-item-main">
                          <span className="ctx-item-name">{b}</span>
                          {cur && uncommitted > 0 && <span className="ctx-item-sub">未提交的更改：{uncommitted} 个文件</span>}
                        </div>
                        {cur && <CheckIcon size={15} className="ctx-item-check" />}
                      </button>
                    );
                  })}
                  {brMatch.length === 0 && <div className="ctx-empty">无匹配分支</div>}
                </div>
                <div className="ctx-sep" />
                <button
                  className="ctx-item"
                  onClick={() => {
                    onOpenGitGraph();
                    close();
                  }}
                >
                  <GitGraphIcon size={15} className="ctx-item-ico" />
                  <span className="ctx-item-name">Git 图谱</span>
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {children}
    </div>
  );
}
