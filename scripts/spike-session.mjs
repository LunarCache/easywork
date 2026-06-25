// R0 spike：验证 pi-coding-agent 的 AgentSession 可无头嵌入（无 TUI），用本地 llama serve 驱动，
// 自带编码工具可用、事件可订阅。用法: node scripts/spike-session.mjs
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createAgentSession, AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

const GGUF = path.join(os.homedir(), ".easywork/models/unsloth__Qwen3-0.6B-GGUF/Qwen3-0.6B-Q4_K_M.gguf");
if (!fs.existsSync(GGUF)) { console.error("缺模型", GGUF); process.exit(2); }
const PORT = 8973;
const bin = process.env.EW_LLAMA_BIN || "llama";

const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ew-sess-cwd-")));
const agentDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ew-sess-agent-")));
fs.writeFileSync(path.join(cwd, "README.md"), "# Spike Project\nThis project is a small teapot demo.\n");

const srv = spawn(bin, ["serve", "-m", GGUF, "--host", "127.0.0.1", "--port", String(PORT), "--jinja", "-c", "4096"], {
  stdio: ["ignore", "ignore", "inherit"],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitReady(t = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < t) { try { if ((await fetch(`http://127.0.0.1:${PORT}/v1/models`)).ok) return true; } catch { /* 服务未就绪，忽略并重试 */ } await sleep(500); }
  return false;
}

const model = {
  id: "qwen3-local", name: "Qwen3-0.6B (local)", api: "openai-completions", provider: "local",
  baseUrl: `http://127.0.0.1:${PORT}/v1`, reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024,
};

async function main() {
  if (!(await waitReady())) throw new Error("llama serve 未就绪");
  console.log("llama serve 就绪；createAgentSession（无头）…");

  const authStorage = AuthStorage.create(path.join(agentDir, "auth.json"));
  authStorage.set("local", { type: "api_key", key: "local" }); // llama serve 忽略，仅为通过 pi 的 key 校验
  const modelRegistry = ModelRegistry.create(authStorage);
  const { session } = await createAgentSession({
    model, thinkingLevel: "off", authStorage, modelRegistry, cwd, agentDir,
    tools: ["read", "ls", "bash"], // 启用 pi 自带编码工具子集
  });

  const seen = {};
  const tools = [];
  let text = "";
  session.subscribe((e) => {
    seen[e.type] = (seen[e.type] ?? 0) + 1;
    if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") text += e.assistantMessageEvent.delta;
    if (e.type === "tool_execution_start") { tools.push(e.toolName); console.log(`  → 工具: ${e.toolName}(${JSON.stringify(e.args).slice(0,80)})`); }
    if (e.type === "tool_execution_end") console.log(`  ← 结果: ${e.toolName} isError=${e.isError}`);
  });

  console.log("prompt: 用 read 读 README.md 并一句话概括\n");
  await session.prompt("用 read 工具读取 README.md，然后用一句话概括这个项目。");

  console.log("\n=== 事件统计 ===", JSON.stringify(seen));
  console.log("=== 工具调用 ===", JSON.stringify(tools));
  console.log("=== 文本(截断) ===", text.trim().slice(0, 200));
  console.log("=== 消息数 ===", session.state.messages.length);
  session.dispose();

  const ok = (seen["agent_end"] ?? 0) > 0;
  console.log(ok ? "\nSPIKE: AgentSession 无头嵌入跑通 ✅" : "\nSPIKE: 未正常收尾 ❌");
  if (tools.length) console.log("SPIKE: pi 自带工具被调用 ✅");
  return ok;
}

main()
  .then((ok) => { srv.kill("SIGKILL"); fs.rmSync(cwd, { recursive: true, force: true }); fs.rmSync(agentDir, { recursive: true, force: true }); process.exit(ok ? 0 : 1); })
  .catch((e) => { console.error("SPIKE 失败:", e?.stack || e?.message || e); srv.kill("SIGKILL"); fs.rmSync(cwd, { recursive: true, force: true }); fs.rmSync(agentDir, { recursive: true, force: true }); process.exit(1); });
