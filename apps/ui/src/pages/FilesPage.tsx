import { useState } from "react";
import type { Project } from "@ew/shared";
import { getClient } from "../lib/client.js";
import { ProjectFileTree } from "../components/ProjectFileTree.js";
import { FileViewer } from "../components/FileViewer.js";
import { ArrowLeftIcon, FileIcon, FolderIcon } from "../icons.js";

/**
 * 项目文件浏览页：占满主区（替代对话），左侧目录树 + 右侧文件预览（统一 FileViewer）。
 * 左上角「返回任务」回到该工作区的对话。由会话列表的「查看文件」图标进入。
 */
export function FilesPage({ project, onBack }: { project: Project; onBack: () => void }) {
  const [sel, setSel] = useState<string | null>(null);

  return (
    <div className="files-page" data-testid="files-page">
      <header className="bar files-bar">
        <button className="files-back" data-testid="files-back" onClick={onBack} title="返回对话">
          <ArrowLeftIcon size={15} /> 返回任务
        </button>
        <span className="files-title" title={project.workspaceDir}>
          {project.name}
        </span>
        <span className="files-sub">{project.workspaceDir}</span>
        <span className="bar-spacer" />
        <button className="fv-btn" title="在文件管理器中打开目录" onClick={() => void getClient().wsReveal(project.id)}>
          <FolderIcon size={15} />
        </button>
      </header>
      <div className="files-body">
        <div className="files-tree">
          <ProjectFileTree projectId={project.id} onOpenFile={setSel} activePath={sel} />
        </div>
        <div className="files-preview">
          {sel ? (
            <FileViewer key={sel} source={{ kind: "fs", scope: "workspace", id: project.id, path: sel }} />
          ) : (
            <div className="files-empty app-empty compact">
              <div className="app-empty-mark">
                <FileIcon size={24} />
              </div>
              <h2>选择文件</h2>
              <p>从左侧目录树打开一个文件进行预览。</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
