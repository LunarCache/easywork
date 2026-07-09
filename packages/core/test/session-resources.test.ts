import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Tool } from "@ew/shared";
import { agentSessionResourceKey, buildAgentSessionResources } from "../src/agent/session-resources.js";

function fakeTool(name: string): Tool {
  return {
    definition: { name, description: `${name} desc`, parameters: { type: "object", properties: {} } },
    source: "builtin",
    requiresApproval: "never",
    execute: async () => ({ content: "ok" }),
  };
}

describe("agent session resources", () => {
  it("uses a stable exclude-skills key", () => {
    expect(agentSessionResourceKey(["beta", "alpha"])).toBe("alpha,beta");
  });

  it("builds runtime, resource loader, and EasyWork custom tools behind one seam", async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ew-session-res-")));
    const cwd = path.join(root, "workspace");
    const agentDir = path.join(root, "agent");
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    try {
      const resources = await buildAgentSessionResources({
        agentDir,
        builtins: [fakeTool("clock")],
        noteMemoryTurn: () => {},
      }, {
        threadId: "thread-1",
        modelId: "model-a",
        cwd,
        memoryScope: "global",
        excludeSkills: ["beta", "alpha"],
      });

      expect(resources.excludeSkillsKey).toBe("alpha,beta");
      expect(resources.runtime.mode).toBe("approve-each");
      expect(resources.runtime.alwaysApproved.size).toBe(0);
      expect(resources.customTools.map((tool) => tool.name)).toEqual(["clock"]);
      expect(resources.resourceLoader).toBeTruthy();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
