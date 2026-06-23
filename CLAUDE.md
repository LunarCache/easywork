# EasyWork — 项目约定（给 Agent）

> 纯推理（无训练/微调）的跨平台本地 AI 工作台。**Agent 内核 = 托管 `@earendil-works/pi`（pi-coding-agent）的 `AgentSession`（无头嵌入）**；EasyWork 退化为它的宿主/集成层——记忆/工具/权限以 pi 扩展 + customTools 接入。TypeScript，Linux / macOS / Windows。
>
> 功能详解 → [docs/FEATURES.md](docs/FEATURES.md)　·　架构 / 技术栈 / 环境变量 → [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)　·　进度 → [docs/PROGRESS.md](docs/PROGRESS.md)

## 架构速览

无头 Node **核心守护进程 `@ew/core` 拥有全部"大脑"**：托管 pi 内核（`SessionHost`）+ 统一 `llama serve` router 进程管理 + 云端 provider + 工具/Skills/MCP + 记忆/知识库 + SQLite。对外 **Fastify HTTP + SSE + `/v1` 网关**。Tauri webview / IM 连接器 / 任意 `/v1` 客户端都是它的**瘦客户端**（同一个大脑服务应用内聊天、外部渠道、无头运行）。

- `core` 是**库**，被 `apps/daemon`（CLI `easywork serve`）与 `apps/desktop`（Tauri sidecar）共同消费。
- **包**：`shared`(zod 契约，所有包依赖它) · `core`(daemon) · `providers`(llama/openai 引擎) · `memory` · `tools` · `skills` · `mcp` · `im-connectors` · `sdk`；`apps/{desktop,ui,daemon}`。
- **唯一原生件 = `sqlite-vec`** 可加载扩展（随包各平台预编译二进制；缺失则向量召回降级纯词法，不崩溃）。本地推理走外部统一 `llama` 二进制（llama.app）的 **router 模式**（`llama serve --models-dir`，单进程多模型路由）；DB 用 `node:sqlite`。架构图与详情见 [ARCHITECTURE](docs/ARCHITECTURE.md)。

## 关键文件（改宿主层从这里找）

- `packages/core/src/agent/session-host.ts` — pi `createAgentSession` 封装；按 threadId 复用 `AgentSession` + **串行化 run**；`mapSessionEvent`(pi→SSE)；`resolveModel` + 采样注入；SessionManager 落盘 resume；`lastUsage`（上下文用量）。
- `packages/core/src/agent/ew-extensions.ts` — 记忆注入(`before_agent_start`)/抽取钩子；`toPiTool`(我们的 `Tool` → pi customTool)；`permissionExtensionFactory` + `escapesCwd`（工作区路径限定）。
- `packages/core/src/server/app.ts` — Fastify 全部路由（`/agent/run`、`/v1`、`/models`、`/workspace/*`、`/threads/*`、`/providers`、`/local/runtime` …）。
- `packages/core/src/engine/{router-server-manager,resolve-llama,net,local-backend}.ts` — `RouterServerManager`（起 1 个 `llama serve --models-dir` router，按 model 路由 + 按需加载 + `--models-max` LRU，实现 `LocalBackend`）+ 运行时解析（优先统一 `llama`，router 只认 kind=llama）。模型 id = 子目录名（routerId）。嵌入模型不走 router（独立 `LlamaServerEngine -m --embedding`）。
- `packages/core/src/openai-compat/router.ts` + `pi-adapt.ts` — `/v1` 网关与 pi↔OpenAI/Anthropic 边界翻译。
- `apps/daemon/src/cli.ts` + `cli/*` — `easywork` CLI（既是 `serve` daemon 入口，也是终端瘦客户端 `repl`/`run`/`models`/`thread`/`mem`/`kb`/`status`/`stop`）。`cli/daemon.ts` 自启/发现本机 daemon；`cli/agent.ts` 渲染 SSE 事件流（助手文本→stdout、装饰→stderr）。复用 `@ew/sdk` 打 HTTP，**后端零改动**（唯一例外：`models rm` 的 `POST /models/local/delete` + `ModelManager.deleteLocal`，含受管目录硬校验）。
- `packages/shared/src/*` — 核心契约（见下）。

## 核心契约（@ew/shared，OpenAI-shaped 为通用语言）

- `InferenceEngine`：`chat()` / `chatStream(): AsyncIterable<ChatStreamEvent>` / `embed?()` + `capabilities`。本地引擎额外 `load/unload/loaded`。
- `ChatStreamEvent`：判别联合 `text-delta` / `tool-call-start|args-delta|end` / `reasoning-delta` / `usage` / `done`。**不用裸字符串流**（无法表达 text 与 tool call 交织）。
- `Tool` / `ToolProvider`：内置工具、MCP 工具统一成 `Tool`，再经 `toPiTool` 桥成 pi customTool（含 `ApprovalGate`）。**自研 `ToolRegistry`/agent loop 已删除**，agent 内核 = pi `AgentSession`。
- `MemoryProvider`：`recall/write/edit/list/delete/deleteBySession/deleteByScope/observe`（均带 `scope`）。本地 = 作用域化分层记忆（全局 markdown 为真相源、可手工编辑回灌；工作区 DB-only）+ sqlite-vec 语义 ⊕ 词法混合召回。
- `AgentEvent`（SSE 对外）：`text/reasoning/tool-start/tool-end/tool-progress/approval-request/memory-recall/usage/final/error`。`mapSessionEvent` 把 pi 事件映射到它。
- `ChannelConnector`：`start/stop/onInbound/reply`；`resolveThreadForChannel(kind, channelUserId)` 映射渠道身份到 thread。

## 关键正确性约束（务必遵守）

> tool-call 解析/交织、调用去重、max-iterations 等**由 pi 内核负责**（自研 loop/healing 已删除）。以下是 EasyWork 宿主层必须守住的：

1. **每 thread 串行化 run**：`SessionHost.run` 用 promise 链按 threadId 串行——同一会话同时只跑一轮。pi 的 `subscribe` 是会话级，并发会跨请求串流 + 审批错配（IM 连发/双击/重连可触发）。
2. **事件映射唯一边界**：`mapSessionEvent`（pi→SSE）+ `pi-adapt.ts`（pi↔OpenAI/Anthropic）是仅有的边界翻译。协议翻译器必须处理 `error` 事件并正确终止（OpenAI error 帧 / Anthropic `event: error`，**不可伪装成 `end_turn`**）。
3. **工作区路径限定**：pi 自带 fs 工具**不做路径沙箱**（`write ../x` 会越界）。`escapesCwd`（`ew-extensions.ts`）经 `realpath` 解软链后硬拦 read/edit/write/ls/grep/find 越界（所有审批档位）；bash 靠审批把守。锁定测试：`workspace-confinement.test` + `permission.test`。
4. **0.0.0.0 暴露强制 api-key**：`RouterServerManager` 绑 0.0.0.0 时必须设 `--api-key`（`/settings/local-net` 校验，切换重启 router）；内部回环调用（pi/proxy/fact-extractor）一并带 Bearer；自连接恒走 127.0.0.1。
5. **SSE 健壮性**：所有 SSE 写口（`/agent/run`、`/v1` 透传、云端分支）须 `raw.on("error")` + `writableEnded/destroyed` 守卫，避免客户端断开后 write-after-end 崩 async handler。
6. **记忆召回**：相关度下限 + topK 上限防 context 稀释；markdown 为真相源、embedding 为派生缓存（变更才重嵌）；召回缓存挂 `RunRuntime`，每轮 `run()` 重置。
7. **sqlite-vec**：`vec0` 表 rowid 须 `BigInt`；`distance_metric=cosine`；扩展为可选依赖，无二进制时降级纯词法（勿让其抛错中断启动）。
8. **个人微信无官方机器人 API** → 只做企业微信（WeCom）；个人微信仅带警告的实验项，不依赖。

## 约定

- **统一 npm**（环境无 pnpm）。
- **测试 201 通过**（vitest；另 1 个真机 e2e 默认 skip）。改 `@ew/core` / `@ew/sdk` 源码后，依赖其 `dist` 的下游（daemon 打包内联 dist）需 `npm run build` 才生效。
- **已移除 node-llama-cpp**：本地推理走外部统一 `llama`（llama.app）的 router 模式，**勿重新引入** node-llama-cpp，也**勿回退每模型一进程的经典 `llama-server`**（已弃用）。
- **打包**：daemon → Node SEA **单文件二进制**（`scripts/build-daemon-sea.mjs`，运行免 Node）；llama 运行时缺失时经 [llama.app](https://llama.app) 自动安装（`resolve-llama.ts` + `/local/install-runtime` + `install.sh`）；`v*` tag → GitHub Actions 出 macOS dmg。
- **改 Tauri Rust（`apps/desktop/src-tauri`）**：本环境有 `cargo`，可 `cargo check` 验证。

## 常用命令

```bash
npm install            # 装依赖
npm run build          # turbo 构建全部包（含 ui/daemon dist）
npm test               # vitest（201 测试）
npm run typecheck      # 全量类型检查　·　npm run lint

# 真机 e2e（需本地模型 + 统一 llama；router 模式）
EW_E2E=1 npx vitest run packages/core/test/session-host.e2e.test.ts

# 开发
npm run dev:daemon     # 仅起 daemon（stdout 首行打印 {baseUrl,token,pid}）
npm run dev:ui         # Vite (5173)；浏览器连 daemon：http://localhost:5173/?baseUrl=<daemon>&token=<token>
npm run dev:desktop    # tauri dev：Rust 壳 + Vite + daemon sidecar

# 打包（需 cargo）
node scripts/build-daemon-sea.mjs           # daemon → 单文件二进制
npm run app:build --workspace @ew/desktop   # macOS dmg + .app

# 冒烟脚本
node scripts/smoke-local.mjs    # 下小模型 + 本地文本推理
node scripts/smoke-vision.mjs   # 视觉模型多模态问答
```

## 参考文件（只读，勿改）

- **pi 内核 API（可移植真相源）**：类型在 `node_modules/@earendil-works/{pi-coding-agent,pi-agent-core,pi-ai}/dist/*.d.ts` —— 写宿主代码时核对 `createAgentSession` / `AgentSession` / 事件 / 工具 / Model / extensions / auth-storage / model-registry 的形状。
  > 若本机另有 pi 源码 clone（路径因机器而异，自行定位），可读其 `packages/coding-agent/src/{core,index.ts}` 看实现；无则以上面 `node_modules` 的 `.d.ts` 为准。

> 注：agent loop / tool_healing / tool-registry 已由 pi 内核取代（自研实现已删除），**勿重新引入**。
