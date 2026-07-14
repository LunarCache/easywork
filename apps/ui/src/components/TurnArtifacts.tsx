import type { TurnArtifact } from "@ew/shared";
import { FileIcon } from "../icons.js";
import { fileType, formatFileSize } from "../lib/filetype.js";

function ArtifactRow({ artifact, onOpenFile }: { artifact: TurnArtifact; onOpenFile?: (path: string) => void }) {
  const ft = fileType(artifact.path);
  const name = artifact.path.split(/[/\\]/).pop() || artifact.path;
  return (
    <button
      className="cv-deliverable-row"
      title={`${artifact.path} — 在工件中预览`}
      onClick={() => onOpenFile?.(artifact.path)}
    >
      <span className="cv-deliverable-badge" style={{ background: ft.color }}>
        {ft.label}
      </span>
      <span className="cv-deliverable-name">{name}</span>
      <span className={`cv-deliverable-kind ${artifact.kind}`}>
        {artifact.kind === "created" ? "新建" : "已更新"}
      </span>
      <span className="cv-deliverable-size">{formatFileSize(artifact.size)}</span>
    </button>
  );
}

export function TurnArtifacts({
  artifacts,
  messageIndex,
  onOpenFile,
}: {
  artifacts: TurnArtifact[];
  messageIndex: number;
  onOpenFile?: (path: string) => void;
}) {
  if (artifacts.length === 0) return null;
  return (
    <section className="cv-deliverables" data-testid={`turn-artifacts-${messageIndex}`}>
      <div className="cv-deliverables-head">
        <FileIcon size={14} />
        <span className="cv-deliverables-title">本轮交付</span>
        <span className="cv-deliverables-count">{artifacts.length} 个文件</span>
      </div>
      <div className="cv-deliverables-list">
        {artifacts.slice(0, 3).map((artifact) => (
          <ArtifactRow key={artifact.path} artifact={artifact} onOpenFile={onOpenFile} />
        ))}
        {artifacts.length > 3 && (
          <details className="cv-deliverables-more">
            <summary>查看其余 {artifacts.length - 3} 个文件</summary>
            {artifacts.slice(3).map((artifact) => (
              <ArtifactRow key={artifact.path} artifact={artifact} onOpenFile={onOpenFile} />
            ))}
          </details>
        )}
      </div>
    </section>
  );
}
