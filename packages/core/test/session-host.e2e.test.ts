import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { AgentEvent } from "@ew/shared";
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

    const host = new SessionHost({ local, providers, agentDir });
    const events: AgentEvent[] = [];
    try {
      for await (const ev of host.run({
        threadId: "t1",
        modelId: GGUF,
        text: "用 read 工具读取 README.md，然后一句话概括这个项目。",
        cwd,
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
  }, 180_000);
});
