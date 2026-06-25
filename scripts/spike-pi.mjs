// Phase 0 spike: 验证 pi-agent-core + pi-ai 能驱动本机 llama serve 跑通「模型→工具→收尾」。
// 用法: node scripts/spike-pi.mjs  （需 llama serve 在 PATH，且 Qwen3 gguf 已下载）
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { agentLoop } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const GGUF = path.join(
  os.homedir(),
  ".easywork/models/unsloth__Qwen3-0.6B-GGUF/Qwen3-0.6B-Q4_K_M.gguf",
);
const PORT = 8971;
const BASE = `http://127.0.0.1:${PORT}`;
const bin = process.env.EW_LLAMA_BIN || "llama";

if (!fs.existsSync(GGUF)) {
  console.error("缺少模型:", GGUF, "（先在 app 下载 Qwen3-0.6B）");
  process.exit(2);
}

console.log("启动 `llama serve`…", bin, GGUF);
const srv = spawn(bin, ["serve", "-m", GGUF, "--host", "127.0.0.1", "--port", String(PORT), "--jinja", "-c", "4096"], {
  stdio: ["ignore", "ignore", "inherit"],
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitReady(timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/v1/models`);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  return false;
}

// pi-ai Model：openai-completions 指向 llama serve。
const model = {
  id: "qwen3",
  name: "Qwen3-0.6B (local)",
  api: "openai-completions",
  provider: "local",
  baseUrl: `${BASE}/v1`,
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 1024,
};

// 两个 typebox 工具：add（验证参数校验 + 执行）、get_time。
const calls = [];
const tools = [
  {
    name: "add",
    label: "加法",
    description: "计算两个整数之和",
    parameters: Type.Object({ a: Type.Number(), b: Type.Number() }),
    async execute(_id, params) {
      calls.push({ name: "add", params });
      return { content: [{ type: "text", text: String(params.a + params.b) }], details: null };
    },
  },
  {
    name: "get_time",
    label: "时间",
    description: "返回当前时间字符串",
    parameters: Type.Object({}),
    async execute(_id) {
      calls.push({ name: "get_time", params: {} });
      return { content: [{ type: "text", text: "2026-06-15T10:00:00Z" }], details: null };
    },
  },
];

async function main() {
  if (!(await waitReady())) throw new Error("llama serve 未就绪");
  console.log("llama serve 就绪，跑 pi agentLoop…\n");

  const prompts = [
    { role: "user", content: "用 add 工具算 21 加 21 等于多少，然后用 get_time 报一下时间。", timestamp: Date.now() },
  ];
  const context = {
    systemPrompt: "你是一个助手。需要计算或取时间时必须调用对应工具，不要自己编。",
    messages: [],
    tools,
  };
  const config = {
    model,
    apiKey: "local", // llama serve 忽略，避免 env key 查找
    convertToLlm: (messages) => messages, // 已是 pi Message
    toolExecutionMode: "parallel",
  };

  const seen = {};
  const stream = agentLoop(prompts, context, config, undefined, streamSimple);
  for await (const ev of stream) {
    seen[ev.type] = (seen[ev.type] ?? 0) + 1;
    if (ev.type === "tool_execution_start") console.log(`  → 工具调用: ${ev.toolName}(${JSON.stringify(ev.args)})`);
    if (ev.type === "tool_execution_end") console.log(`  ← 工具结果: ${ev.toolName} isError=${ev.isError}`);
    if (ev.type === "message_end" && ev.message?.role === "assistant") {
      const text = (ev.message.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
      if (text.trim()) console.log(`  助手: ${text.trim().slice(0, 200)}`);
    }
  }
  const finalMsgs = await stream.result();

  console.log("\n=== 事件统计 ===", JSON.stringify(seen));
  console.log("=== 工具实际执行 ===", JSON.stringify(calls));
  console.log("=== 最终消息数 ===", finalMsgs.length);
  const ok = seen["agent_end"] > 0;
  console.log(ok ? "\nSPIKE: agent loop 跑通 ✅" : "\nSPIKE: 未正常收尾 ❌");
  if (calls.length > 0) console.log("SPIKE: 工具调用打通 ✅");
  else console.log("SPIKE: 模型未触发工具（0.6B 可能能力不足；loop/provider 链路本身已验证）");
  return ok;
}

main()
  .then((ok) => {
    srv.kill("SIGKILL");
    process.exit(ok ? 0 : 1);
  })
  .catch((e) => {
    console.error("SPIKE 失败:", e?.message || e);
    srv.kill("SIGKILL");
    process.exit(1);
  });
