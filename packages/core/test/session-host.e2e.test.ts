import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { AgentEvent, MemoryProvider, MemoryItem } from "@ew/shared";
import { EngineRegistry } from "../src/engine/registry.js";
import { RouterServerManager } from "../src/engine/router-server-manager.js";
import { resolveLlamaBin } from "../src/engine/resolve-llama.js";
import { ProviderManager } from "../src/providers/manager.js";
import { SessionHost } from "../src/agent/session-host.js";

// R1 真机 smoke：SessionHost 经真实 `llama serve` router 跑通 pi AgentSession，产出我们的 AgentEvent。
// 这层用于本地/发布前验证真实 runtime，较重，需本地模型 + 统一 llama（router 模式），默认跳过；EW_E2E=1 开启。
const RUN = process.env.EW_E2E === "1";
const MODELS_DIR = path.join(os.homedir(), ".easywork/models");
const GGUF = path.join(MODELS_DIR, "unsloth__Qwen3-4B-GGUF/Qwen3-4B-Q4_K_M.gguf");
const llamaBin = resolveLlamaBin();

describe.skipIf(!RUN || !fs.existsSync(GGUF) || !llamaBin)("SessionHost e2e", () => {
  it("drives pi AgentSession via local `llama serve` router and emits AgentEvent stream", async () => {
    const registry = new EngineRegistry();
    const local = new RouterServerManager(registry, { binaryPath: llamaBin!, modelsDir: MODELS_DIR });
    const providers = new ProviderManager(registry);
    const { id: modelId } = await local.load({ modelPath: GGUF, contextSize: 4096 });

    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ew-r1-")));
    const agentDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ew-r1-agent-")));
    fs.writeFileSync(path.join(cwd, "README.md"), "# Demo\nThis is a teapot project.\n");

    // 记录型记忆：验证记忆扩展的 `before_agent_start` 清单钩子（现设计 = memory.list）经真实 pi 运行时触发。
    let listCalls = 0;
    const memory: MemoryProvider = {
      id: "rec",
      recall: async () => [] as MemoryItem[],
      observe: async () => {},
      write: async () => ({}) as MemoryItem,
      edit: async () => ({}) as MemoryItem,
      list: async () => {
        listCalls++;
        return [];
      },
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
        modelId,
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
    console.log("R1 e2e event types:", JSON.stringify([...new Set(types)]));
    // 经 `llama serve` router 跑通完整一轮：工具循环（read）+ 收尾 final。
    expect(events.filter((e) => e.type === "final").length).toBe(1);
    expect(types).toContain("tool-start");
    expect(types).toContain("tool-end");
    // 记忆扩展 before_agent_start 清单钩子（现设计 = memory.list）经真实 pi 运行时触发。
    console.log("memory.list calls:", listCalls);
    expect(listCalls).toBeGreaterThan(0);
    // R4：read 属放行类，不触发审批；workspace 模式整体仍正常收尾。
    console.log("R4 approvalCalls:", approvalCalls);
  }, 180_000);
});
