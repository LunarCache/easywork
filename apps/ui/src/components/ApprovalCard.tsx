import { ShieldIcon } from "../icons.js";

export type ApprovalVerdict = "approve" | "approve-always" | "deny";

/** 工具参数 → 精简单行预览：bash 取命令、fs 取路径，其余压成单行 JSON。 */
function argPreview(args: unknown): string {
  if (args && typeof args === "object") {
    const a = args as Record<string, unknown>;
    for (const k of ["command", "path", "file_path", "url", "pattern", "query"]) {
      if (typeof a[k] === "string") return a[k] as string;
    }
  }
  try {
    const s = JSON.stringify(args);
    return s === "{}" || s === "null" || s === undefined ? "" : s;
  } catch {
    return String(args);
  }
}

/** 工具审批卡（对话栏上方内嵌、非遮罩弹层）。Chat 与 Workspace 共用。 */
export function ApprovalCard({
  toolName,
  args,
  onRespond,
}: {
  toolName: string;
  args: unknown;
  onRespond: (verdict: ApprovalVerdict) => void;
}) {
  const preview = argPreview(args);
  let full = "";
  try {
    full = JSON.stringify(args, null, 2);
  } catch {
    full = String(args);
  }
  return (
    <div className="approval-wrap">
      <div className="approval-card">
        <div className="approval-head">
          <ShieldIcon size={15} className="approval-ico" />
          <span className="approval-q">
            允许运行 <code className="approval-tool-name">{toolName}</code>？
          </span>
          <div className="approval-actions">
            <button className="btn-ghost" onClick={() => onRespond("deny")}>
              拒绝
            </button>
            <button className="btn-ghost" onClick={() => onRespond("approve-always")}>
              总是允许
            </button>
            <button onClick={() => onRespond("approve")}>允许</button>
          </div>
        </div>
        {preview && (
          <div className="approval-arg" title={full}>
            {preview}
          </div>
        )}
      </div>
    </div>
  );
}
