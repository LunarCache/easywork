# EasyWork — 本地 AI 工作台

> 纯推理（无训练/微调）的跨平台本地 AI 工作台。下载并运行本地 GGUF 模型，也可接云端 OpenAI-兼容模型；具备 Agent 工具能力（pi 自带编码工具 + 内置工具 / Skills / MCP）；支持应用内聊天与外部 IM 渠道，带可插拔记忆系统。
> **Agent 内核 = 托管 `@earendil-works/pi`（pi-coding-agent）的 `AgentSession`（无头嵌入）**；EasyWork 退化为它的宿主/集成层。记忆/工具/权限以 pi 扩展 + customTools 接入。TypeScript 开发，支持 Linux / macOS / Windows。

## 核心架构：Core Daemon 模型

一个无头 Node **核心守护进程（@ew/core）拥有全部"大脑"**：pi-coding-agent 内核（`SessionHost` 托管）、推理（llama-server 进程管理 + 云端 provider）、工具/Skills/MCP、记忆、知识库、SQLite 存储。对外暴露 **本地 HTTP API + SSE**（Fastify）。

Tauri webview UI、外部 IM 连接器、以及外部工具（Claude Code 等通过 `/v1` OpenAI/Anthropic 兼容端点）**都是这个 daemon 的瘦客户端**。这样"同一个大脑"既服务应用内聊天，也服务 Telegram/Discord 等外部渠道，还能无头运行（`easywork serve`）。

```
                 ┌──────────────────────────────────────────┐
                 │            CORE DAEMON (@ew/core)          │
                 │  pi-coding-agent 内核(SessionHost 托管)     │
                 │  ew-extensions(记忆/权限/桥接工具) ·        │
                 │  llama-server host · skills · MCP · memory  │
                 │  SQLite store · /v1 网关(本地透传+云端 pi)  │
                 │  Fastify HTTP + SSE + /v1 + /v1/messages    │
                 └──────────────────────────────────────────┘
    spawn/lease ▲       ▲ HTTP+SSE        ▲ HTTP+SSE     ▲ HTTP /v1
  ┌─────────────┘       │                 │              │
  │ Tauri 主进程(Rust)  │ IM connectors   │ React UI     │ Claude Code /
  │  └ webview(React)   │ (TG/Discord/    │ (@ew/sdk)    │ 任意 /v1 客户端
  │                     │  WeCom/Feishu)  │              │
  └─────────────────────┴─────────────────┴──────────────┘
```

**进程布局**（已从 Electron 迁移到 **Tauri 2**）
- **Tauri 主进程（Rust）**：窗口/菜单/自动更新 + 以 sidecar 方式 spawn 并健康检查 daemon。读取 daemon stdout 首行的 `{baseUrl, token}`，经 `get_config` 命令注入 webview（连接信息对 UI 不可见）。不做推理逻辑。
- **Core daemon**：detached Node 子进程（`easywork serve`，stdout 首行打印 `{baseUrl, token, pid}`）。也可独立 CLI 无头运行。
- **本地推理**：每个加载的模型一个 `llama-server` 子进程（`LocalServerManager`，含 LRU 淘汰，env `EW_MAX_LOADED_MODELS` 可调）。**已移除 node-llama-cpp**。
- **Webview（React UI）**：纯 UI，零 node；经 `get_config` 拿到 `{baseUrl, token}`，用 `@ew/sdk` 走 HTTP/SSE。

## Monorepo 结构（npm workspaces + Turborepo）

```
packages/
  shared/         @ew/shared        纯 zod schema + 类型（零运行时依赖）——契约层，所有包依赖它
  core/           @ew/core          daemon 库：Fastify server、routes、SessionHost(托管 pi)、ew-extensions(记忆/权限/桥接工具)、/v1 网关(本地透传+云端 pi-ai)、engine registry、SQLite store、LocalServerManager
  providers/      @ew/providers     LlamaServerEngine（llama-server 子进程，支持 --api-key）/ openai-compatible
  memory/         @ew/memory        MemoryProvider 接口 + local + mem0
  tools/          @ew/tools         内置工具（time/calculator/http_get/web_search，桥成 pi customTools）+ SSRF/路径沙箱
  skills/         @ew/skills        Skills 发现/加载/执行（pi 亦自带 skills，经 resourceLoader）
  mcp/            @ew/mcp           MCP client（@modelcontextprotocol/sdk）；工具桥成 pi customTools
  im-connectors/  @ew/im-connectors telegram/discord/wecom/feishu
  sdk/            @ew/sdk           daemon HTTP API 的类型化客户端（UI/连接器/测试共用）
apps/
  desktop/        @ew/desktop       Tauri 2 外壳（Rust src-tauri）+ sidecar 启动 daemon
  ui/             @ew/ui            React 前端（Vite），Tauri webview 加载
  daemon/         @ew/daemon        CLI 入口 `easywork serve`
resources/        图标、默认 skills、模型 catalog
```

**依赖方向**：所有包依赖 `shared`，`shared` 不反向依赖。`core` 是**库**，被 `apps/daemon` 与 `apps/desktop` 共同消费。本地推理走外部 `llama-server` 二进制（子进程），DB 用 Node 内置 `node:sqlite`。**唯一原生件是 `sqlite-vec` 可加载扩展（`@ew/core` 依赖）**：记忆语义召回的**唯一引擎**（已移除 JS 余弦 brute-force）；它随包提供各平台预编译二进制（非源码编译，不同于早期 better-sqlite3 的 ABI 痛点）。极端情况下平台无对应二进制 → 记忆召回退化为纯词法（不崩溃）。

## 技术栈

- **Agent 内核**：`@earendil-works/pi`（pi-coding-agent / pi-agent-core / pi-ai）。`SessionHost`（`packages/core/src/agent/session-host.ts`）封装 `createAgentSession` 无头嵌入，按 threadId 复用一个 `AgentSession`（保留上下文/自动 compaction），把 pi `AgentSessionEvent` 映射为我们的 SSE `AgentEvent`。EasyWork 专有能力经 `ew-extensions.ts` 接入：记忆（pi `context` 钩子注入召回 + `agent_end` 抽取）、`toPiTool`（我们的 `Tool` → pi customTool）、权限（pi `tool_call` 钩子 ↔ `ApprovalGate` 4 档 + `escapesCwd` 工作区路径限定）。pi 模型走 `ModelRegistry`/`AuthStorage`（本地 = 指向 llama-server 端口的 openai-completions Model；云端含 OAuth）。
- **本地推理**：llama.cpp `llama-server` 子进程（OpenAI + 原生 Anthropic `/v1/messages`，带 `--jinja`）。文本/视觉(`--mmproj`)/embedding(`--embedding`) 全走它。`LlamaServerEngine` 管理进程并委托内部 OpenAICompatibleEngine；`LocalServerManager` 每模型一个 server 进程、含 LRU、可配置绑定 host（127.0.0.1 / 0.0.0.0）与 `--api-key`。`EngineRegistry` 现服务 `/v1` 回退（云端经 pi 出错时）+ fact-extractor + embedding（非 agent 内核）。**已移除 node-llama-cpp**。需机器有 `llama-server`（Mac `brew install llama.cpp`；env `EW_LLAMA_SERVER` 可指定路径；打包时随附二进制）
- **HTTP**：Fastify（schema-first、原生 SSE）
- **契约/校验**：zod + zod-to-json-schema（一份 schema → TS 类型 + 函数调用 JSON Schema）
- **本地 DB**：`node:sqlite`（Node 内置 DatabaseSync，**零原生编译**，Node 26 可用；规避 better-sqlite3 在新 ABI 上编译失败的 #1 打包风险）
- **记忆向量召回**：本地 CPU embedding（参考 Hermes，默认 **nomic-embed-text** 768 维，经 `llama-server --embedding` 运行）+ **混合召回**（语义 cosine ⊕ 词法，0.75/0.25 加权）。语义分**一律走 sqlite-vec**（`vec0` 虚拟表，`distance_metric=cosine`，经 `node:sqlite` `loadExtension`；rowid 须传 `BigInt`）——**JS 余弦 brute-force 已移除**。`embedding` blob 仍存于 `memory_items`（durable 重建源），`vec_items` 是查询索引、随写/改/删/reindex 同步。未启用 embedding（或扩展无二进制）时降级为纯词法。**注入分两路**：会话期**冻结快照**（`buildMemorySnapshot`，全量持久记忆，记忆扩展闭包内缓存、每轮置顶注入）+ 每轮**动态召回**（按相关度 top-K）。被动抽取的事实带来源 `sessionId`，删除对话时经 `deleteBySession` 一并清除（模型 `manage_memory`/手工写入的无 sessionId 全局事实不受影响）。
- **UI**：React 19 + Vite + @assistant-ui/react + @tanstack/react-router + Zustand + TanStack Query
- **桌面**：Tauri 2（Rust 外壳 + TS 前端；sidecar 启动 Node daemon）
- **库构建**：tsup（esbuild）
- **测试**：Vitest（workspace）+ Playwright（桌面 e2e）
- **Monorepo**：npm workspaces + Turborepo（**注意：环境无 pnpm，统一用 npm**）
- **密钥**：当前 provider/MCP 配置（含 apiKey）持久化在 daemon 的 SQLite `settings` 表；后续可迁移到 OS keychain（keytar / Tauri stronghold）。

环境：Node v26 / npm 11。当前无原生 addon（llama-server 为外部二进制、`node:sqlite` 内置），打包以随附 `llama-server` 二进制为主。

## 核心契约（@ew/shared，OpenAI-shaped 为通用语言）

- `InferenceEngine`：`chat()` / `chatStream(): AsyncIterable<ChatStreamEvent>` / `embed?()` + `capabilities`。本地引擎额外 `load/unload/loaded`。
- `ChatStreamEvent`：判别联合 `text-delta` / `tool-call-start|args-delta|end` / `reasoning-delta` / `usage` / `done`。**不用裸字符串流**（无法表达 text 与 tool call 交织）。
- `Tool` / `ToolProvider`：内置工具、MCP 工具统一成 `Tool`，再经 `toPiTool` 桥成 pi customTool（含 `ApprovalGate`）。**注**：自研 `ToolRegistry`/agent loop 已删除，agent 内核 = pi `AgentSession`。
- `MemoryProvider`：`recall/write/edit/list/delete/deleteBySession/observe`。本地 = 分层 markdown（真相源）+ sqlite-vec 语义（回退 JS 余弦）⊕ 词法混合召回。
- `AgentEvent`（SSE 对外事件）：`text/reasoning/tool-start/tool-end/tool-progress/approval-request/memory-recall/usage/final/error`。`mapSessionEvent` 把 pi 事件映射到它。
- `ChannelConnector`：`start/stop/onInbound/reply`。`resolveThreadForChannel(kind, channelUserId)` 映射渠道身份到 thread → 跨渠道同一大脑。

## 关键正确性约束（实现时务必遵守）

> tool-call 解析/交织、调用去重、max-iterations 等**现由 pi 内核负责**（自研 loop/healing/tool-registry 已删除）。下面是 EasyWork 宿主层必须守住的约束：

1. **每 thread 串行化 run**：`SessionHost.run` 用 promise 链按 threadId 串行——同一会话同一时刻只跑一轮。pi 的 `subscribe` 是会话级，并发会跨请求串流 + 共享 runtime 审批错配（IM 连发/双击/重连可触发）。
2. **事件映射唯一边界**：`mapSessionEvent`（pi→SSE）+ `pi-adapt.ts`（pi↔OpenAI/Anthropic）是仅有的边界翻译。协议翻译器必须处理 `error` 事件并正确终止（OpenAI error 帧 / Anthropic `event: error`，**不可伪装成 `end_turn`**）。
3. **工作区路径限定**：pi 自带 fs 工具**不做路径沙箱**（`write ../x` 会越界）。`escapesCwd`（`ew-extensions.ts`）经 `realpath` 解析软链接后硬拦 read/edit/write/ls/grep/find 的越界路径（所有审批档位）；bash 是任意 shell，靠审批把守。锁定测试：`workspace-confinement.test`（记录 pi 原始越界）+ `permission.test`（拦截）。
4. **0.0.0.0 暴露强制 api-key**：`LocalServerManager` 绑 0.0.0.0 时必须设 `--api-key`（`/settings/local-net` 校验），内部回环调用（pi/proxy/fact-extractor）一并带 Bearer；引擎自连接恒走 127.0.0.1 回环。
5. **SSE 健壮性**：所有 SSE 写口（`/agent/run`、`/v1` 透传、云端分支）须 `raw.on("error")` + `writableEnded/destroyed` 守卫，避免客户端断开后 write-after-end 崩 async handler。
6. **记忆召回**：相关度下限 + topK 上限防 context 稀释；markdown 为真相源，embedding 为派生缓存，变更才重嵌；召回缓存挂 `RunRuntime`，每轮 `run()` 重置。
7. **个人微信无官方机器人 API** → 只做企业微信（WeCom）；个人微信仅作带警告的实验性可选项，不依赖它。

## 常用命令

```bash
npm install                 # 安装全部 workspace 依赖
npm run build               # turbo 构建全部包（含 ui dist、desktop dist）
npm test                    # vitest（176 测试）
EW_E2E=1 npx vitest run packages/core/test/session-host.e2e.test.ts   # 真机 e2e（需本地模型 + llama-server）
npm run typecheck           # 全量类型检查
npm run lint                # eslint

# 无头 / 开发
npm run dev:daemon          # 仅起 daemon（easywork serve，stdout 首行打印 {baseUrl,token}）
node apps/daemon/dist/cli.js serve   # 直接跑 daemon

# 桌面（Tauri 2：需 Rust 工具链 cargo）
npm run dev:ui              # 起 Vite (http://localhost:5173)
npm run dev:desktop         # tauri dev：编译 Rust 壳、起 Vite(beforeDevCommand) 并 spawn daemon sidecar

# 浏览器里直接连 daemon（无桌面壳）：
#   npm run dev:ui 后访问 http://localhost:5173/?baseUrl=<daemon>&token=<token>

# 实测脚本
node scripts/smoke-local.mjs     # 下载小模型 + 本地文本推理（llama-server）
node scripts/smoke-vision.mjs    # 下载视觉模型 + llama-server sidecar 多模态图片问答
node scripts/spike-session.mjs   # pi AgentSession 无头嵌入 spike（R0 决策门）
```

## 参考文件（只读，勿改这些目录）

- `~/workspace/github/pi/packages/coding-agent/src/{core,index.ts}` — pi 内核源码：`createAgentSession`、`AgentSession`、tools、extensions、auth-storage、model-registry。是当前 agent 内核的真相源。
- pi 类型在 `node_modules/@earendil-works/{pi-coding-agent,pi-agent-core,pi-ai}/dist/*.d.ts`（写宿主代码时核对事件/工具/Model 形状）。
- `unsloth/` / Hermes — 早期借鉴的能力**思路**（记忆分层、RAG、混合召回）；agent loop/tool_healing 部分已被 pi 取代，勿再移植。

## 进展

见 `docs/PROGRESS.md`（每完成一个里程碑更新）。完整计划见 plan 文件。
