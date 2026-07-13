# EasyWork · 架构

> 功能见 [FEATURES](FEATURES.md)；进度见 [PROGRESS](PROGRESS.md)；开发约定的权威来源是 [AGENTS.md](../AGENTS.md)。

## Core Daemon 模型

一个无头的 Node **核心守护进程（`apps/daemon` 组装 `@ew/core`）拥有全部“大脑”**：托管 pi-coding-agent 内核（`SessionHost`）、推理（统一 `llama serve` router 进程管理 + 云端 provider）、工具 / Skills / MCP、记忆、知识库、SQLite 存储，以及 `ChannelOperations` / `ChannelGateway` / `ConnectorHost`。Core 对外暴露**本地 HTTP API + SSE**（Fastify），并由进程内的渠道模块主动连接或接收 Telegram、Feishu/Lark、WeChat 等平台流量。应用内聊天与 IM 渠道复用同一个 `SessionHost`；OpenAI/Anthropic 兼容 `/v1` 则是直接推理入口，复用本地 router / 云端 provider runtime，但不调用 `SessionHost.run`、不创建带记忆和工具的 `AgentSession`。

```
                 ┌─────────────────────────────────────────────┐
                 │       CORE DAEMON (apps/daemon + @ew/core)    │
                 │  pi-coding-agent 内核（SessionHost 托管）     │
                 │  ew-extensions（记忆 / 权限 / 工具桥接）      │
                 │  ChannelOperations · Gateway · ConnectorHost │
                 │  llama router host · skills · MCP · RAG      │
                 │  SQLite · Fastify HTTP/SSE · /v1 网关        │
                 └─────────────────────────────────────────────┘
       owned child ▲          ▲ HTTP+SSE        ▲ 平台协议       ▲ HTTP /v1
                   │          │                 │               │
  ┌────────────────┴─┐  ┌─────┴────────┐  ┌─────┴──────────┐  ┌─┴──────────────┐
  │ Tauri 主进程      │  │ React webview │  │ TG / Feishu /  │  │ Claude Code /  │
  │（spawn / 退出回收）│  │ 或浏览器 UI   │  │ Lark / WeChat  │  │ 任意 /v1 客户端 │
  └──────────────────┘  └──────────────┘  └────────────────┘  └────────────────┘
```

- **Tauri 主进程（Rust）**：创建窗口并持有 daemon child；读取 child stdout 首行的 `{baseUrl, token}`，保存后通过 `get_config` 返回给 webview，退出时杀掉 child。Rust 层目前没有菜单或自动更新，也不负责 HTTP 探活；React UI 会重试 `get_config`，再请求 `/health`。**打包时启动随附的单文件 daemon 二进制（Node SEA，免 Node）**；开发时运行 `node $EW_DAEMON_ENTRY serve`。
- **Core daemon 的三种进程形态**：显式 `easywork serve` 在前台运行；需要 daemon 且启用自动启动的 CLI 命令探测不到服务时，会 detached spawn 自身的 `serve` 并 `unref()`（`status` / `stop` 只检查现有服务，不自启）；Tauri 启动的是由桌面主进程持有、随应用退出回收的 child，不是 detached 自启进程。
- **本地推理**：统一 `llama`（llama.app）的 **router 模式** —— 1 个 `llama serve --models-dir` 进程，按请求 `model`（即模型子目录名）路由、按需 auto-load、`--models-max` LRU 淘汰。嵌入模型走独立 `llama serve -m --embedding` 进程。DB 用内置 `node:sqlite`；唯一原生件是 **sqlite-vec** 可加载扩展（随包提供各平台预编译二进制，记忆 / 知识库向量召回用；缺失则降级纯词法）。

## Monorepo 结构（npm workspaces + Turborepo）

```
packages/
  shared/         @ew/shared        Zod schema、类型与少量运行时 helper（契约层；运行时依赖 zod）
  core/           @ew/core          daemon 库：server / routes / SessionHost(托管 pi) / ew-extensions / ChannelOperations / /v1 网关 / RAG / store
  providers/      @ew/providers     LlamaServeEngine（--host/--api-key）/ OpenAICompatibleEngine / harmony 解析
  memory/         @ew/memory        local Core Memory + additive external recall + SqliteVecIndex 语义 ⊕ 词法召回
  tools/          @ew/tools         内置工具 + SSRF 防护
  skills/         @ew/skills        Skills 发现 / 渐进披露 / 执行（候选学习状态由 core/skill-learning 管理）
  mcp/            @ew/mcp           MCP client（stdio + HTTP）
  im-connectors/  @ew/im-connectors Channel Gateway + adapter registry（Telegram long-poll；Feishu/Lark WebSocket 默认 + webhook 高级模式；WeChat iLink QR + long-poll；Discord / WeCom 规划中）
  sdk/            @ew/sdk           daemon HTTP API 的类型化客户端
apps/
  desktop/        @ew/desktop       Tauri 2 外壳（Rust src-tauri）+ 启动/持有随附 daemon child
  ui/             @ew/ui            React 19 + Vite 前端
  daemon/         @ew/daemon        CLI 入口 easywork + core daemon 的 serve 宿主
```

依赖方向：`shared` 是运行时契约中心；`core` 组合 providers / memory / tools / skills / MCP / IM 等包，并由 `apps/daemon` 直接导入。`apps/desktop` 不直接消费 `@ew/core`，而是把 `@ew/daemon` 的 SEA 产物作为资源启动，再由 webview 通过 HTTP/SSE 访问。

## Provider Catalog 与模型身份

云端模型由 `ProviderManager`、`ProviderCatalog` 与 `AgentProviderRuntime` 分层处理：

- `CloudProviderConfig` 记录 provider 身份、API family、端点/鉴权和逐模型配置；内置 provider 复用 pi-ai 原生注册，自定义 provider 由同一契约接入。
- `ProviderCatalog` 从 pi-ai 生成服务商/模型目录，并提供 `GET /providers/catalog`；自定义端点可经 `POST /providers/probe-models` 调标准 `/models` 拉取模型 ID，UI 失败时回退手工配置。
- 目录模板的运行时继承范围是名称、`reasoning`、`thinkingLevelMap` 与 `maxTokens`（显式配置的 `reasoning` 优先）；上下文窗口和输入模态始终读取已保存的 `modelConfig`。UI 选择或自动匹配模板时，会把模板的上下文与模态物化进该配置。`compat` 是**报文协议行为**，仅当模板 API 与 provider 当前 API 一致时才进入运行时模型。
- `auto` 模式可按精确模型 ID 推导唯一/同名前缀模板，因此已有自定义配置无需重新保存也能恢复上述运行时元数据；这不等于运行时覆盖已保存的上下文窗口或输入模态。
- 云端模型的新 route id 由 `providerModelRouteId` 生成，格式为 `provider:<url-encoded-providerId>:<url-encoded-modelId>`，provider ID 与上游模型 ID 都会 URL 编码；进入 pi `ModelRegistry` 或上游请求前才解码并还原真实 `modelId`。`resolveModelRef` 仍接受 legacy 裸 `modelId` 供旧调用点兼容，但新接口使用 provider-scoped route id，避免不同 provider 的同名模型互相覆盖。`GET /models` 的 `modelSources` 同时返回 `providerId/modelId/reasoning`，供模型分组、展示和对话框默认思考档位使用。

Chat / Workspace 的思考档位仍是用户偏好：无保存值时，`reasoning:true` 的模型默认 `medium`，其它模型默认 `off`；用户显式选择 `off` 后也会按 route id 保存，不会在重载时恢复成 `medium`。

## Channel Gateway

`ChannelOperations`、`ChannelGateway` 与 `ConnectorHost` 都在 core 进程内；外部的是 Telegram、Feishu/Lark、WeChat 等平台连接（WebSocket / long-poll / webhook），不是另一个通过 HTTP/SSE 调 core 的 gateway 进程。`@ew/im-connectors` 提供小接口的 **Channel Gateway**：

- `ChannelAdapter`：平台实现的 seam，负责 `start/stop/send/handleWebhook?`，并把平台消息归一成 `InboundMessage`。
- `ChannelAdapterRegistry`：注册平台 adapter；当前内置 Telegram、Feishu/Lark 与 WeChat iLink，后续 Discord gateway、WeCom callback 都挂这里。
- `ChannelGateway`：托管配置、状态、生命周期、allowlist 鉴权、webhook 分发和出站 `ChannelTarget` 透传。
- `ConnectorHost`：唯一把入站消息接到同一个大脑的宿主层，负责 `resolveThreadForChannel`、载历史、调用 `SessionHost.run`、把 `AgentEvent` 聚合为 IM 回复并落库。
- `ChannelOperations`（`@ew/core`）：core 侧应用层模块，包住 gateway/host，把连接器 CRUD/启停、Feishu/WeChat 扫码 setup session、inbox read model 与 `/inbox/events` SSE invalidation 收成一个边界；HTTP route 只做鉴权后的参数校验和响应映射。

`@ew/core` 暴露以下管理面：`GET /im/adapters`，`GET/POST /im/connectors`，`POST /im/connectors/:id/start`，`POST /im/connectors/:id/stop`，以及 `DELETE /im/connectors/:id`。这些路由都走 daemon Bearer 鉴权，并由 `ChannelOperations` 调用 gateway 完成实际变更。Feishu/Lark 扫码注册 helper 是 `POST /im/feishu/register` 与 `GET/DELETE /im/feishu/register/:id`：core 启动 SDK registerApp 短会话，二维码确认成功后自动保存 `transport:websocket` 连接器并按需启动；取消或 core stop 会 abort 未完成扫码会话，避免取消后落库。WeChat 对应 `POST /im/wechat/register` 与 `GET/DELETE /im/wechat/register/:id`，通过同一 setup session 模式完成 iLink QR 登录和 connector 保存。`GET /inbox/threads` 是给桌面收件箱的只读读模型：从 `ConversationRepo` 里筛选 `thread.channel`，聚合最后一条文本消息和消息数，不引入第二套 IM 消息表；`GET /inbox/events` 是 Bearer 鉴权的 SSE 失效通知，只发 `ready/changed`，消息正文仍通过 read model 读取。`ALL /im/:id/webhook` 是平台回调入口，不要求 EasyWork 内部 Bearer；平台签名、secret token 或事件来源校验应在对应 adapter 里完成。Core 只针对 webhook 捕获 raw body 供签名校验，并在读取前/读取中执行 32MiB 上限。Feishu/Lark adapter 的高级 webhook 模式负责 URL verification、Verification Token、`X-Lark-Signature`、加密回调解密、文本消息归一化和文本回复；非 `transport:webhook` 或未配置 `verificationToken`/`encryptKey` 时拒绝 public webhook。渠道配置先落 SQLite settings；平台 secret 目前随配置存储，后续可在不改 adapter seam 的情况下迁到 keychain/secret ref。

### 记忆与 Skill 学习边界

- `LocalMemoryProvider` 是唯一可写真相源：全局 Core Memory 只有 User Profile / Agent Notes，工作区只有 conventions / decisions / pitfalls；Extracted Fact 在提升前带 Source Conversation 所有权。`AdditiveMemoryProvider` 只在 Agent/IM 的 recall 上叠加受扫描、限长、带来源与 untrusted fence 的外部结果，失败/禁用/移除不影响本地。HTTP 管理面仍直接编辑本地记忆。
- `SessionHost` 同时服务 Chat、Workspace、CLI agent 和 IM，因此这些入口都获得相同记忆、`stage_skill_candidate` 与 pi Skill 发现；`/v1` 只调用模型 runtime helper，不进入上述链路。
- `SkillCandidateStore/Service/Coordinator` 位于 core：foreground Learn 通过普通 Agent turn 暂存候选，background reviewer 只接收冻结 trajectory 和 Skill catalog，迁移器把旧 memory-layer skills 分类成 candidate/fact/ambiguous。只有用户批准会经过 package/工具/secret/injection/path/symlink/hash 验证并原子写入 Skill source。learned Skills 的遥测、patch、pin、stale/archive、snapshot/restore/rollback 也由该模块拥有。

## 技术栈

| 关注点 | 选型 |
|---|---|
| Agent 内核 | `@earendil-works/pi`（pi-coding-agent）`AgentSession` 无头托管；记忆 / 工具 / 权限经扩展 + customTools 接入 |
| 本地推理 | llama.app 统一 `llama` 的 `llama serve` **router 模式**（`--models-dir` 单进程多模型路由 + 按需加载 + `--models-max` LRU）；嵌入独立 `llama serve -m --embedding` |
| HTTP | Fastify 路由编排；SSE 通过 Node `reply.raw` 手写 |
| 契约 / 校验 | Zod 共享契约；HTTP handler 通过 `safeParse` 等手动校验请求 |
| 本地 DB | `node:sqlite`（内置 DatabaseSync，零原生编译） |
| 记忆 / RAG | 本地 Core Memory + 可选 additive provider；独立 `llama serve --embedding`（默认 nomic）+ **sqlite-vec**；记忆按 `0.75 × 语义 + 0.25 × 词法` 加权，知识库用 dense / lexical RRF；向量或 provider 不可用时本地词法链路仍工作 |
| UI | React 19 + Vite + react-markdown |
| 桌面 | Tauri 2（Rust 外壳 + TS 前端；Rust 启动并持有 daemon child） |
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

> UI「设置 → 模型 → 本地模型 → 网络访问」持久化的是 `llama serve` router 的绑定 host（`127.0.0.1` / `0.0.0.0`）与 api-key，并重启 router 使设置生效；它暴露的是 router 自带的 `/v1`，**不会改变 core Fastify 网关的监听地址**。Core 仍按 `easywork serve` 的 `--host` / `EW_HOST` 启动（默认 `127.0.0.1`）。router 绑定 `0.0.0.0` 时强制要求 api-key，daemon 的内部调用始终走 `127.0.0.1` 并携带 Bearer。

## 平台说明

**Windows 工作区建议安装 Git for Windows**（[下载](https://git-scm.com/download/win)）：git 改动审阅需要 `git`，当前 Agent 命令执行则使用 pi-coding-agent 自带的 `bash` 工具。pi 会先探测 Git Bash 的标准安装路径，再查找 PATH 中的 `bash.exe`（也可来自 Cygwin / MSYS2 等）；没有 bash 时该工具会报出安装提示。旧的 EasyWork custom tool `run_command` 及其 `EW_GIT_BASH` 解析不再是 Agent 主执行路径。macOS / Linux 由 pi 优先使用 `/bin/bash`，再回退 PATH 中的 bash 或 `sh`。

> **关于持久化**：pi `SessionManager` 已按 threadId 落盘 + resume，daemon 重启后模型仍带上重启前上下文；`ConversationRepo` 仍是 UI / 全文检索 / 渠道映射 / 项目元数据的真相源（两者并存，刻意不做"单一真相源"替换——会丢 FTS5 检索 / 渠道映射且大改 UI/SDK 而无净收益）。
