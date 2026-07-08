# EasyWork · 架构

> 功能见 [FEATURES](FEATURES.md)；进度见 [PROGRESS](PROGRESS.md)；开发约定的权威来源是 [AGENTS.md](../AGENTS.md)。

## Core Daemon 模型

一个无头的 Node **核心守护进程（`@ew/core`）拥有全部"大脑"**：托管 pi-coding-agent 内核（`SessionHost`）、推理（统一 `llama serve` router 进程管理 + 云端 provider）、工具 / Skills / MCP、记忆、知识库、SQLite 存储。对外暴露**本地 HTTP API + SSE**（Fastify）。Tauri 桌面壳、外部 IM 连接器、以及任意 `/v1` 客户端都是它的**瘦客户端**——同一个大脑既服务应用内聊天，也服务外部渠道，还能无头运行。

```
                 ┌──────────────────────────────────────────┐
                 │            CORE DAEMON (@ew/core)          │
                 │  pi-coding-agent 内核(SessionHost 托管)     │
                 │  ew-extensions(记忆/权限/桥接工具)          │
                 │  llama router host · skills · MCP · RAG      │
                 │  SQLite store · /v1 网关(本地透传+云端 pi)  │
                 │  Fastify HTTP + SSE + /v1 + /v1/messages    │
                 └──────────────────────────────────────────┘
    spawn sidecar ▲       ▲ HTTP+SSE        ▲ HTTP+SSE    ▲ HTTP /v1
  ┌───────────────┘       │                 │            │
  │ Tauri 主进程(Rust)    │ Channel Gateway │ React UI   │ Claude Code /
  │  └ webview(React)     │ (TG/Feishu/…)   │ (@ew/sdk)  │ 任意 /v1 客户端
  └───────────────────────┴─────────────────┴────────────┘
```

- **Tauri 主进程（Rust）**：窗口 / 菜单 / 自动更新 + 以 sidecar spawn 并健康检查 daemon。读取 daemon stdout 首行的 `{baseUrl, token}`，经 `get_config` 注入 webview（连接信息对 UI 不可见）。**打包时启动随附的单文件 daemon 二进制（Node SEA，免 Node）**；开发时 `node $EW_DAEMON_ENTRY`。
- **Core daemon**：detached Node 子进程（`easywork serve`），也可独立无头运行。
- **本地推理**：统一 `llama`（llama.app）的 **router 模式** —— 1 个 `llama serve --models-dir` 进程,按请求 `model`(=模型子目录名)路由、按需 auto-load、`--models-max` LRU 淘汰。嵌入模型走独立 `llama serve -m --embedding` 进程。DB 用内置 `node:sqlite`；唯一原生件是 **sqlite-vec** 可加载扩展（随包提供各平台预编译二进制，记忆 / 知识库向量召回用；缺失则降级纯词法）。

## Monorepo 结构（npm workspaces + Turborepo）

```
packages/
  shared/         @ew/shared        纯 zod schema + 类型（契约层，零运行时依赖）
  core/           @ew/core          daemon 库：server / routes / SessionHost(托管 pi) / ew-extensions / /v1 网关 / RAG / store
  providers/      @ew/providers     LlamaServerEngine（--host/--api-key）/ OpenAICompatibleEngine / harmony 解析
  memory/         @ew/memory        MemoryProvider：local（作用域化分层 + SqliteVecIndex 语义 ⊕ 词法召回）+ mem0
  tools/          @ew/tools         内置工具 + SSRF 防护
  skills/         @ew/skills        Skills 发现 / 渐进披露 / 执行
  mcp/            @ew/mcp           MCP client（stdio + HTTP）
  im-connectors/  @ew/im-connectors Channel Gateway + adapter registry（Telegram long-poll；Feishu/Lark WebSocket 默认 + webhook 高级模式；WeChat iLink QR + long-poll；Discord / WeCom 规划中）
  sdk/            @ew/sdk           daemon HTTP API 的类型化客户端
apps/
  desktop/        @ew/desktop       Tauri 2 外壳（Rust src-tauri）+ sidecar 启动 daemon
  ui/             @ew/ui            React 18 + Vite 前端
  daemon/         @ew/daemon        CLI 入口 easywork serve
```

依赖方向：所有包依赖 `shared`；`core` 是库，被 `apps/daemon` 与 `apps/desktop` 共同消费。

## Channel Gateway

外部 IM 不直接调用 `SessionHost`。`@ew/im-connectors` 提供小接口的 **Channel Gateway**：

- `ChannelAdapter`：平台实现的 seam，负责 `start/stop/send/handleWebhook?`，并把平台消息归一成 `InboundMessage`。
- `ChannelAdapterRegistry`：注册平台 adapter；当前内置 Telegram、Feishu/Lark 与 WeChat iLink，后续 Discord gateway、WeCom callback 都挂这里。
- `ChannelGateway`：托管配置、状态、生命周期、allowlist 鉴权、webhook 分发和出站 `ChannelTarget` 透传。
- `ConnectorHost`：唯一把入站消息接到同一个大脑的宿主层，负责 `resolveThreadForChannel`、载历史、调用 `SessionHost.run`、把 `AgentEvent` 聚合为 IM 回复并落库。

`@ew/core` 暴露管理面：`GET /im/adapters`、`GET/POST/DELETE /im/connectors`、`POST /im/connectors/:id/start|stop`，这些都走 daemon Bearer 鉴权。Feishu/Lark 另有 `POST/GET/DELETE /im/feishu/register` 扫码注册 helper：core 启动 SDK registerApp 短会话，二维码确认成功后自动保存 `transport:websocket` 连接器并按需启动；取消或 core stop 会 abort 未完成扫码会话，避免取消后落库。`GET /inbox/threads` 是给桌面收件箱的只读读模型：从 `ConversationRepo` 里筛选 `thread.channel`，聚合最后一条文本消息和消息数，不引入第二套 IM 消息表；`GET /inbox/events` 是 Bearer 鉴权的 SSE 失效通知，只发 `ready/changed`，消息正文仍通过 read model 读取。`ALL /im/:id/webhook` 是平台回调入口，不要求 EasyWork 内部 Bearer；平台签名、secret token 或事件来源校验应在对应 adapter 里完成。Core 只针对 webhook 捕获 raw body 供签名校验，并在读取前/读取中执行 32MiB 上限。Feishu/Lark adapter 的高级 webhook 模式负责 URL verification、Verification Token、`X-Lark-Signature`、加密回调解密、文本消息归一化和文本回复；非 `transport:webhook` 或未配置 `verificationToken`/`encryptKey` 时拒绝 public webhook。渠道配置先落 SQLite settings；平台 secret 目前随配置存储，后续可在不改 adapter seam 的情况下迁到 keychain/secret ref。

## 技术栈

| 关注点 | 选型 |
|---|---|
| Agent 内核 | `@earendil-works/pi`（pi-coding-agent）`AgentSession` 无头托管；记忆 / 工具 / 权限经扩展 + customTools 接入 |
| 本地推理 | llama.app 统一 `llama` 的 `llama serve` **router 模式**（`--models-dir` 单进程多模型路由 + 按需加载 + `--models-max` LRU）；嵌入独立 `llama serve -m --embedding` |
| HTTP | Fastify（schema-first、原生 SSE） |
| 契约 / 校验 | zod + zod-to-json-schema |
| 本地 DB | `node:sqlite`（内置 DatabaseSync，零原生编译） |
| 记忆 / RAG | 本地 CPU embedding（nomic-embed-text 768 维）+ **sqlite-vec** 语义 ⊕ 词法混合召回（RRF）；记忆作用域化 + 渐进式披露 |
| UI | React 18 + Vite + react-markdown |
| 桌面 | Tauri 2（Rust 外壳 + TS 前端，sidecar 启动 daemon） |
| 打包 | daemon Node SEA 单文件二进制；Tauri dmg；GitHub Actions（`v*` tag → Releases） |
| 库构建 / 测试 | tsup（esbuild）/ Vitest |
| Monorepo | npm workspaces + Turborepo |

## 环境变量

| 变量 | 作用 |
|---|---|
| `EW_LLAMA_BIN` | 指定 llama.app 统一 `llama` 可执行文件路径（缺省自动解析 PATH + `~/.local/bin` 等；经典 llama-server 已不支持） |
| `EW_MAX_LOADED_MODELS` | router `--models-max`：同时常驻模型数上限（默认 4） |
| `EW_SQLITE_VEC` | 指定 sqlite-vec 可加载扩展路径（打包二进制用；缺省同目录 / node_modules 解析） |
| `EW_ALLOW_STDIO_MCP=1` | 允许 stdio MCP（默认禁用，会在本机执行任意命令） |
| `EW_DATA_DIR` | 数据目录（默认 `~/.easywork`） |

> 本地网络暴露（绑定 host `127.0.0.1` / `0.0.0.0` 与 api-key）在 daemon 的 SQLite `settings` 表持久化，由 UI「设置 → 本地网络」管理（非环境变量）。

## 平台说明

**Windows 运行需安装 Git**（[Git for Windows](https://git-scm.com/download/win)）。工作区模式用它做两件事：① git 改动审阅面板；② 命令执行工具（`run_command`）会优先用 Git 自带的 **bash.exe** + Unix 工具（`ls`/`cat`/`grep` 等）执行命令，否则模型生成的 Unix 命令在 `cmd.exe` 下无法运行。装好后通常自动探测；如未在标准路径，可用 env `EW_GIT_BASH` 指定 `bash.exe` 路径。macOS / Linux 用系统自带 `/bin/sh` + git，无需额外配置。

> **关于持久化**：pi `SessionManager` 已按 threadId 落盘 + resume，daemon 重启后模型仍带上重启前上下文；`ConversationRepo` 仍是 UI / 全文检索 / 渠道映射 / 项目元数据的真相源（两者并存，刻意不做"单一真相源"替换——会丢 FTS5 检索 / 渠道映射且大改 UI/SDK 而无净收益）。
