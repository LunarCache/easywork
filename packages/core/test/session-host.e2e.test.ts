import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { AgentEvent, MemoryProvider, MemoryItem } from "@ew/shared";
import { EngineRegistry } from "../src/engine/registry.js";
import { LocalServerManager } from "../src/engine/local-server-manager.js";
import { ProviderManager } from "../src/providers/manager.js";
import { SessionHost } from "../src/agent/session-host.js";

// R1 真机 e2e：SessionHost 经真实 llama-server 跑通 pi AgentSession，产出我们的 AgentEvent。
// 重，需本地模型 + llama-server，默认跳过；EW_E2E=1 开启。
const RUN = process.env.EW_E2E === "1";
const GGUF = path.join(os.homedir(), ".easywork/models/unsloth__Qwen3-0.6B-GGUF/Qwen3-0.6B-Q4_K_M.gguf");

describe.skipIf(!RUN || !fs.existsSync(GGUF))("SessionHost e2e", () => {
  it("drives pi AgentSession via local llama-server and emits AgentEvent stream", async () => {
    const registry = new EngineRegistry();
    const local = new LocalServerManager(registry);
    const providers = new ProviderManager(registry);
    await local.load({ modelPath: GGUF, contextSize: 4096 });

    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ew-r1-")));
    const agentDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ew-r1-agent-")));
    fs.writeFileSync(path.join(cwd, "README.md"), "# Demo\nThis is a teapot project.\n");

    // 记录型记忆：验证 R3 扩展钩子（context 召回 + agent_end 抽取）经真实 pi 运行时触发。
    let recallCalls = 0;
    let observeCalls = 0;
    const memory: MemoryProvider = {
      id: "rec",
      recall: async () => {
        recallCalls++;
        return [] as MemoryItem[];
      },
      observe: async () => {
        observeCalls++;
      },
      write: async () => ({}) as MemoryItem,
      edit: async () => ({}) as MemoryItem,
      list: async () => [],
      delete: async () => {},
    };

    // R4：工作区模式 + 审批门（自动批准，计数）——验证权限扩展与真实 pi 工具循环集成无碍。
    let approvalCalls = 0;
    const approval = {
      request: async () => {
        approvalCalls++;
        return "approve" as const;
      },
    };

    const host = new SessionHost({ local, providers, agentDir, memory });
    const events: AgentEvent[] = [];
    try {
      for await (const ev of host.run({
        threadId: "t1",
        modelId: GGUF,
        text: "用 read 工具读取 README.md，然后一句话概括这个项目。",
        cwd,
        workspace: true,
        approval,
        approvalMode: "approve-each",
      })) {
        events.push(ev);
      }
    } finally {
      host.disposeAll();
      await local.stopAll();
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(agentDir, { recursive: true, force: true });
    }

    const types = events.map((e) => e.type);
    console.log("R1 e2e event types:", JSON.stringify(types));
    expect(types).toContain("final");
    const finals = events.filter((e) => e.type === "final");
    expect(finals.length).toBe(1);
    // R3：context 钩子（召回）与 agent_end 钩子（抽取）均经真实 pi 运行时触发。
    console.log("R3 hooks:", JSON.stringify({ recallCalls, observeCalls }));
    expect(recallCalls).toBeGreaterThan(0);
    expect(observeCalls).toBeGreaterThan(0);
    // R4：read 属放行类，不触发审批；workspace 模式整体仍正常收尾。
    console.log("R4 approvalCalls:", approvalCalls);
  }, 180_000);
});
