import type { ApprovalMode, Tool } from "@ew/shared";
import { makeFsTools, makeExecTool } from "@ew/tools";

/**
 * 按工作区审批模式组装 fs/exec 工具集（参考 Codex 的 approval 档位）。
 *
 * | mode         | fs_read/list/grep | fs_write/edit | run_command |
 * |--------------|-------------------|---------------|-------------|
 * | read-only    | never             | （不注入）    | （不注入）  |
 * | approve-each | never             | always        | always      |
 * | auto-edits   | never             | never         | always      |
 * | full-auto    | never             | never         | never       |
 *
 * read-only 靠"不注入写/exec 工具"而非审批 deny —— 更强的保证。
 */
export function workspaceTools(mode: ApprovalMode): Tool[] {
  if (mode === "read-only") {
    return makeFsTools({ includeWrite: false });
  }
  const writeApproval = mode === "approve-each" ? "always" : "never";
  const execApproval = mode === "full-auto" ? "never" : "always";
  return [...makeFsTools({ writeApproval, includeWrite: true }), makeExecTool({ approval: execApproval })];
}
