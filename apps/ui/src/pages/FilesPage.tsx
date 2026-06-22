import { useState } from "react";
import type { Project } from "@ew/shared";
import { getClient } from "../lib/client.js";
import { ProjectFileTree } from "../components/ProjectFileTree.js";
import { FilePreviewView, type FilePreview } from "../components/SideDock.js";
import { ArrowLeftIcon, FolderIcon } from "../icons.js";

/**
 * 项目文件浏览页：占满主区（替代对话），左侧目录树 + 右侧文件预览。
 * 左上角「返回任务」回到该工作区的对话。由会话列表的「查看文件」图标进入。
 */
export function FilesPage({ project, onBack }: { project: Project; onBack: () => void }) {
  const [sel, setSel] = useState<string | null>(null);
  const [data, setData] = useState<FilePreview | null>(null);
  const [mode, setMode] = useState<"code" | "preview">("code");

  const openFile = async (p: string) => {
    setSel(p);
    setData(null);
    setMode(/\.html?$/i.test(p) ? "preview" : "code");
    try {
      setData(await getClient().wsRead(project.id, p));
    } catch {
      setData({ size: 0 });
    }
  };

  return (
    <div className="files-page">
      <header className="bar files-bar">
        <button className="files-back" onClick={onBack} title="返回对话">
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
          <ProjectFileTree projectId={project.id} onOpenFile={(p) => void openFile(p)} activePath={sel} />
        </div>
        <div className="files-preview">
          {sel ? (
            <FilePreviewView path={sel} data={data} mode={mode} setMode={setMode} />
          ) : (
            <div className="files-empty">从左侧选择文件查看内容</div>
          )}
        </div>
      </div>
    </div>
  );
}
