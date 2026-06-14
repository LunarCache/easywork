# EasyWork — 本地 AI 工作台

> 纯推理（无训练/微调）的跨平台本地 AI 工作台。下载并运行本地 GGUF 模型，也可接云端 OpenAI-兼容模型；具备 Agent 工具能力（内置工具 / Skills / MCP）；支持应用内聊天与外部 IM 渠道，带可插拔记忆系统。
> 参考 Unsloth Studio 与 Hermes Studio 的能力**思路**，独立实现（不抄袭）。TypeScript 开发，支持 Linux / macOS / Windows。

## 核心架构：Core Daemon 模型

一个无头 Node **核心守护进程（@ew/core）拥有全部"大脑"**：推理引擎、agent loop、工具/Skills/MCP、记忆、SQLite 存储、provider 注册表。对外暴露 **本地 HTTP API + SSE**（Fastify）。

Tauri webview UI、外部 IM 连接器、以及外部工具（Claude Code 等通过 `/v1` OpenAI-兼容端点）**都是这个 daemon 的瘦客户端**。这样"同一个大脑"既服务应用内聊天，也服务 Telegram/Discord 等外部渠道，还能无头运行（`easywork serve`）。

```
                 ┌──────────────────────────────────────────┐
                 │            CORE DAEMON (@ew/core)          │
                 │  推理引擎(llama-server host) · agent loop  │
                 │  tools · skills · MCP client · memory      │
                 │  SQLite store · provider registry          │
                 │  Fastify HTTP + SSE + /v1 OpenAI-compat     │
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
  core/           @ew/core          daemon 库：Fastify server、routes、/v1、agent loop、解析器、engine 路由、registry、SQLite store、LocalServerManager
  providers/      @ew/providers     LlamaServerEngine（llama-server 子进程）/ openai-compatible
  memory/         @ew/memory        MemoryProvider 接口 + local + mem0
  tools/          @ew/tools         内置工具（web fetch、fs、代码沙箱[默认关]）
  skills/         @ew/skills        Skills 发现/加载/执行
  mcp/            @ew/mcp           MCP client（@modelcontextprotocol/sdk）
  im-connectors/  @ew/im-connectors telegram/discord/wecom/feishu
  sdk/            @ew/sdk           daemon HTTP API 的类型化客户端（UI/连接器/测试共用）
apps/
  desktop/        @ew/desktop       Tauri 2 外壳（Rust src-tauri）+ sidecar 启动 daemon
  ui/             @ew/ui            React 前端（Vite），Tauri webview 加载
  daemon/         @ew/daemon        CLI 入口 `easywork serve`
resources/        图标、默认 skills、模型 catalog
```

**依赖方向**：所有包依赖 `shared`，`shared` 不反向依赖。`core` 是**库**，被 `apps/daemon` 与 `apps/desktop` 共同消费。**目前无原生 addon**：本地推理走外部 `llama-server` 二进制（子进程），DB 用 Node 内置 `node:sqlite`，向量召回用 JS 余弦 brute-force —— 规避了原生模块 ABI/打包痛点。

## 技术栈

- **本地推理（统一）**：llama.cpp `llama-server` 子进程（OpenAI 兼容，参考 Unsloth）。文本/视觉(`--mmproj`)/embedding(`--embedding`) 全走它。`LlamaServerEngine` 管理进程并委托内部 OpenAICompatibleEngine；`LocalServerManager` 每模型一个 server 进程并注册到 EngineRegistry。**已移除 node-llama-cpp**（避免原生 addon + 统一后端 + 与 Unsloth 一致）。需机器有 `llama-server`（Mac `brew install llama.cpp`；env `EW_LLAMA_SERVER` 可指定路径；打包时随附二进制）
- **HTTP**：Fastify（schema-first、原生 SSE）
- **契约/校验**：zod + zod-to-json-schema（一份 schema → TS 类型 + 函数调用 JSON Schema）
- **本地 DB**：`node:sqlite`（Node 内置 DatabaseSync，**零原生编译**，Node 26 可用；规避 better-sqlite3 在新 ABI 上编译失败的 #1 打包风险）
- **记忆向量召回**：本地 CPU embedding（参考 Hermes，默认 **nomic-embed-text** 768 维，经 `llama-server --embedding` 运行）+ **混合召回**（语义 cosine ⊕ 词法，0.75/0.25 加权）。向量用 JS 余弦 brute-force（记忆规模够用，可后替 sqlite-vec/hnsw）。未启用 embedding 时降级为纯词法。
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
- `Tool` / `ToolRegistry` / `ToolProvider`：内置工具、MCP 工具、Skills 统一成 `Tool` 进同一注册表；含 `ApprovalGate`。
- `MemoryProvider`：`recall/write/edit/list/delete/observe`。本地 = 分层 markdown（真相源）+ JS 余弦语义 ⊕ 词法混合召回。
- `ChannelConnector`：`start/stop/onInbound/reply`。`resolveThreadForChannel(kind, channelUserId)` 映射渠道身份到 thread → 跨渠道同一大脑。

## 关键正确性约束（实现时务必遵守）

1. **流式与 tool-call 交织**：非原生 tool-call 引擎用尾缓冲 `stripToolCallMarkup`，**绝不吐出半个 `<tool_call>`/`<function=` 标签**，仅在流结束时结构化产出 tool call。
2. **自愈解析器**（移植自 `unsloth/studio/backend/core/tool_healing.py`）：大括号平衡 + 字符串转义感知 + 闭合标签可选；name 字符类含 `-`（MCP 命名空间 `mcp__srv__tool` 依赖）。用参考的精确性用例锁定。
3. **agent loop 安全**：`canonicalToolCallKey`（参数排序后稳定序列化）去重打断重复调用；max-iterations + 强制收尾；tool 错误一律作为 tool 消息喂回模型自纠，不抛出；`JSON.parse(args)` 包裹 try。
4. **记忆召回**：相关度下限 + topK 上限防 context 稀释；markdown 为真相源，embedding 为派生缓存，变更才重嵌。
5. **个人微信无官方机器人 API** → 只做企业微信（WeCom）；个人微信仅作带警告的实验性可选项，不依赖它。

## 常用命令

```bash
npm install                 # 安装全部 workspace 依赖
npm run build               # turbo 构建全部包（含 ui dist、desktop dist）
npm test                    # vitest（61 测试）
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
```

## 参考文件（仅借鉴思路，勿改 unsloth/ 目录）

- `unsloth/studio/backend/core/tool_healing.py` — 逐行移植到 TS 的解析器
- `unsloth/studio/backend/core/inference/tool_loop_controller.py` — agent loop 的 dedup/noop 模式
- `unsloth/studio/backend/core/inference/mcp_client.py` — MCP cooloff + 工具缓存
- `unsloth/studio/backend/core/inference/tools.py` — 内置工具 + RAG autoinject
- `unsloth/studio/backend/core/rag/store.py` — sqlite-vec + FTS5 混合检索

## 进展

见 `docs/PROGRESS.md`（每完成一个里程碑更新）。完整计划见 plan 文件。
