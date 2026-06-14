import { describe, it, expect } from "vitest";
import type { ApprovalMode } from "@ew/shared";
import { workspaceTools } from "../src/agent/workspace-approval.js";

function byName(mode: ApprovalMode): Record<string, string | ((a: unknown) => boolean)> {
  const out: Record<string, string | ((a: unknown) => boolean)> = {};
  for (const t of workspaceTools(mode)) out[t.definition.name] = t.requiresApproval as never;
  return out;
}

describe("workspaceTools 审批映射", () => {
  it("read-only：仅只读工具，无写/exec", () => {
    const m = byName("read-only");
    expect(Object.keys(m).sort()).toEqual(["fs_grep", "fs_list", "fs_read"]);
  });

  it("approve-each：写=always，exec=always", () => {
    const m = byName("approve-each");
    expect(m["fs_write"]).toBe("always");
    expect(m["fs_edit"]).toBe("always");
    expect(m["run_command"]).toBe("always");
    expect(m["fs_read"]).toBe("never");
  });

  it("auto-edits：写=never，exec=always", () => {
    const m = byName("auto-edits");
    expect(m["fs_write"]).toBe("never");
    expect(m["run_command"]).toBe("always");
  });

  it("full-auto：写=never，exec=never", () => {
    const m = byName("full-auto");
    expect(m["fs_write"]).toBe("never");
    expect(m["run_command"]).toBe("never");
  });
});
