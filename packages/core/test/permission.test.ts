import { describe, it, expect } from "vitest";
import type { ApprovalGate, ApprovalMode, ApprovalVerdictResult } from "@ew/shared";
import type { ExtensionAPI, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { decideTool, permissionExtensionFactory, escapesCwd, type RunRuntime } from "../src/agent/ew-extensions.js";

describe("decideTool", () => {
  const modes: ApprovalMode[] = ["read-only", "approve-each", "auto-edits", "full-auto"];
  it("read + safe customTools always allowed", () => {
    for (const m of modes) {
      expect(decideTool("read", m)).toBe("allow");
      expect(decideTool("ls", m)).toBe("allow");
      expect(decideTool("manage_memory", m)).toBe("allow");
      expect(decideTool("search_knowledge_base", m)).toBe("allow");
    }
  });
  it("write (edit/write)", () => {
    expect(decideTool("write", "read-only")).toBe("block");
    expect(decideTool("write", "approve-each")).toBe("approve");
    expect(decideTool("edit", "auto-edits")).toBe("allow");
    expect(decideTool("edit", "full-auto")).toBe("allow");
  });
  it("bash + mcp", () => {
    for (const t of ["bash", "mcp__srv__do"]) {
      expect(decideTool(t, "read-only")).toBe("block");
      expect(decideTool(t, "approve-each")).toBe("approve");
      expect(decideTool(t, "auto-edits")).toBe("approve");
      expect(decideTool(t, "full-auto")).toBe("allow");
    }
  });
});

function capture(runtime: RunRuntime, cwd = "/work"): (e: ToolCallEvent) => Promise<ToolCallEventResult> {
  let handler!: (e: ToolCallEvent) => Promise<ToolCallEventResult>;
  const pi = {
    on: (name: string, h: unknown) => {
      if (name === "tool_call") handler = h as typeof handler;
    },
  } as unknown as ExtensionAPI;
  permissionExtensionFactory(runtime, cwd)(pi);
  return handler;
}
const ev = (toolName: string, input: Record<string, unknown> = {}): ToolCallEvent =>
  ({ type: "tool_call", toolCallId: "c", toolName, input }) as ToolCallEvent;

describe("escapesCwd", () => {
  it("flags fs paths that leave cwd; allows in-cwd", () => {
    expect(escapesCwd("write", { path: "a/b.txt" }, "/work")).toBeNull();
    expect(escapesCwd("read", { path: "./x" }, "/work")).toBeNull();
    expect(escapesCwd("write", { path: "../escape.txt" }, "/work")).toBe("../escape.txt");
    expect(escapesCwd("edit", { path: "/etc/passwd" }, "/work")).toBe("/etc/passwd");
    // bash 不静态检查（任意 shell，由审批把守）。
    expect(escapesCwd("bash", { command: "rm -rf /" }, "/work")).toBeNull();
  });
});

describe("permissionExtensionFactory", () => {
  it("allows read, blocks write under read-only", async () => {
    const h = capture({ mode: "read-only", alwaysApproved: new Set() });
    expect(await h(ev("read"))).toEqual({});
    expect(await h(ev("write"))).toMatchObject({ block: true });
  });

  it("approve mode → consults gate; deny blocks", async () => {
    let asked = 0;
    const gate: ApprovalGate = {
      request: async () => {
        asked++;
        return "deny" as ApprovalVerdictResult;
      },
    };
    const h = capture({ mode: "approve-each", approval: gate, alwaysApproved: new Set() });
    expect(await h(ev("bash"))).toMatchObject({ block: true });
    expect(asked).toBe(1);
  });

  it("approve-always memoizes per tool (gate asked once)", async () => {
    let asked = 0;
    const gate: ApprovalGate = {
      request: async () => {
        asked++;
        return "approve-always" as ApprovalVerdictResult;
      },
    };
    const rt: RunRuntime = { mode: "approve-each", approval: gate, alwaysApproved: new Set() };
    const h = capture(rt);
    expect(await h(ev("bash"))).toEqual({});
    expect(await h(ev("bash"))).toEqual({});
    expect(asked).toBe(1);
    expect(rt.alwaysApproved.has("bash")).toBe(true);
  });

  it("no gate → allow (avoid deadlock when no UI)", async () => {
    const h = capture({ mode: "approve-each", alwaysApproved: new Set() });
    expect(await h(ev("bash"))).toEqual({});
  });

  it("blocks fs path escape even in full-auto (hard boundary)", async () => {
    const h = capture({ mode: "full-auto", alwaysApproved: new Set() }, "/work");
    expect(await h(ev("write", { path: "../../etc/cron", content: "x" }))).toMatchObject({ block: true });
    // 工作区内的写在 full-auto 下放行。
    expect(await h(ev("write", { path: "src/a.ts", content: "x" }))).toEqual({});
  });
});
