# EasyWork — 项目约定（给 Agent）

> 纯推理（无训练/微调）的跨平台本地 AI 工作台。**Agent 内核 = 托管 `@earendil-works/pi`（pi-coding-agent）的 `AgentSession`（无头嵌入）**；EasyWork 退化为它的宿主/集成层——记忆/工具/权限以 pi 扩展 + customTools 接入。TypeScript，Linux / macOS / Windows。
>
> 功能详解 → [docs/FEATURES.md](docs/FEATURES.md)　·　架构 / 技术栈 / 环境变量 → [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)　·　进度 → [docs/PROGRESS.md](docs/PROGRESS.md)

## 架构速览

无头 Node **核心由 `apps/daemon` 组装 `@ew/core`，拥有全部 Agent "大脑"**：托管 pi 内核（`SessionHost`）+ 统一 `llama serve` router 进程管理 + 云端 provider + 工具/Skills/MCP + 记忆 + SQLite。对外提供 **Fastify HTTP + SSE + `/v1` 网关**。Tauri webview 与 CLI 是它的瘦客户端；IM adapter/gateway/host 运行在 core 进程内，直接调用同一个 `SessionHost`。`/v1` 客户端只复用 daemon 的模型/provider runtime，不经过 AgentSession、记忆或工具。

- `core` 是**库**，由 `apps/daemon`（CLI `easywork serve`）直接依赖并组装；`apps/desktop` 不直接依赖 `@ew/core`，而是打包/启动 daemon 单文件 sidecar，webview 再通过 HTTP/SSE 连接它。
- **包**：`shared`(zod 契约，所有包依赖它) · `core`(daemon) · `providers`(llama/openai 引擎) · `memory` · `tools` · `skills` · `mcp` · `im-connectors` · `sdk`；`apps/{desktop,ui,daemon}`。
- **唯一原生件 = `sqlite-vec`** 可加载扩展（随包各平台预编译二进制；缺失则向量召回降级纯词法，不崩溃）。本地推理走外部统一 `llama` 二进制（llama.app）的 **router 模式**（`llama serve --models-dir`，单进程多模型路由）；DB 用 `node:sqlite`。架构图与详情见 [ARCHITECTURE](docs/ARCHITECTURE.md)。

## 关键文件（改宿主层从这里找）

- `packages/core/src/agent/session-host.ts` — pi `createAgentSession` 封装；按 threadId 复用 `AgentSession` + **串行化 run**；`mapSessionEvent`(pi→SSE)；`resolveModel` + 本地模型默认采样注入；SessionManager 落盘 resume；`lastUsage`（上下文用量）。
- `apps/ui/src/lib/agent-turn.ts` + `hooks/useAgentTurn.ts` — 客户端 **Agent Turn** 深模块：统一发送 / 重试 / 停止 / 审批 / SSE 消费 / usage / artifacts / final；Chat / Workspace 只提供请求与刷新 policy。
- `apps/ui/src/lib/workbench-view-session.ts` + `hooks/useWorkbenchViewSession.ts` — **Workbench View Session** 深模块：统一工作台零视图初态、视图打开 / 激活 / 关闭回退与文件、URL 导航；`SideDock` 只负责布局、空态动作和渲染。
- `apps/ui/src/lib/native-browser-runtime.ts` + `apps/desktop/src-tauri/src/browser_surface.rs` — Desktop Browser surface adapter：远程 http(s) 页面由无 IPC 权限的 Tauri 子 WebView 承载并同步 SideDock 边界；关闭 / dispose 仍由 Workbench View Session 统一拥有，Web 运行时仍使用 sandbox iframe，HTML 工件仍用受控 `srcDoc`。
- `apps/ui/src/lib/terminal-panel-session.ts` + `hooks/useTerminalPanelSession.ts` — **Terminal Panel Session** 深模块：统一 Desktop PTY 恢复、创建、激活、关闭回退与前台任务确认；终端独立于 SideDock，在对话区底部渲染。
- `packages/core/src/agent/ew-extensions.ts` — 记忆注入(`before_agent_start`)/抽取钩子；`toPiTool`(我们的 `Tool` → pi customTool)；`permissionExtensionFactory` + `escapesCwd`（工作区路径限定）。
- `packages/core/src/conversations/source-conversation-lifecycle.ts` — **Source Conversation** 删除 / Project 删除深模块：统一 run claim、删除屏障、来源事实 / Skill Candidate / 消息 / FTS / pi session 清理与非致命 scratch 工件回收；不删除用户工作区目录。
- `packages/core/src/skill-learning/candidate-service.ts` — `SkillCandidateLifecycle`：统一 Candidate 审核资格、验证、来源、批准、Learned Skill 遥测 / 固定 / 快照 / 归档 / 恢复 / 回滚；store / filesystem / reviewer 是内部 adapter。
- `packages/core/src/providers/model-configuration.ts` — **Provider Model Configuration** 的唯一语义所有者：从保存配置解析 scoped route、上游 model id、协议对应的 runtime Base URL、最终 runtime model 与安全投影；Provider 可另存仅供编辑复用的 `connections[]` 预设，实际运行仍只消费 provider 默认值与 `modelConfigs[]` 内联覆盖；`ProviderCatalog` 只负责目录 / probe。
- `packages/core/src/server/app.ts` — Fastify 应用装配入口（`/agent/run`、`/v1`、`/models`、`/workspace/*`、`/threads/*`、`/providers`、`/local/runtime` …）；跨路由生命周期对象在这里创建并在 `stop()` 中统一收尾。
- `packages/core/src/models/local-model-settings.ts` — 本地模型运行设置存储；`models.local.settings` 按模型保存默认采样参数，供聊天 / 工作区 / 渠道在未显式传参时共用。
- `packages/core/src/channels/operations.ts` — Channel Operations 应用层模块：包住 `ChannelGateway` + `ConnectorHost`，集中连接器生命周期、Feishu/WeChat 扫码 setup session、inbox read model 与 SSE invalidation；HTTP routes 只做请求/响应适配。
- `packages/core/src/channels/secret-store.ts` — 渠道密钥安全存储 seam：macOS Keychain / Linux Secret Service / Windows 当前用户 DPAPI；旧 SQLite 明文配置由 `app.ts` 启动时迁移，API 只返回 `secretKeys` 元数据。
- `packages/core/src/engine/{router-server-manager,resolve-llama,net,local-backend}.ts` — `RouterServerManager`（起 1 个 `llama serve --models-dir` router，按 model 路由 + 按需加载 + `--models-max` LRU，实现 `LocalBackend`）+ 统一 `llama` 运行时解析（只定位 llama.app 的 `llama` 可执行文件，不再接受经典 `llama-server`）。模型 id = 子目录名（routerId）。嵌入模型不走 router（独立 `LlamaServeEngine`，启动 `llama serve -m <gguf> --embedding`）。
- `packages/core/src/openai-compat/router.ts` + `pi-adapt.ts` — `/v1` 网关与 pi↔OpenAI/Anthropic 边界翻译。
- `packages/im-connectors/src/{adapter,registry,gateway,host,telegram,feishu,wechat}.ts` — Channel Gateway：adapter seam + 内置 adapter registry + 连接器配置/状态/allowlist/webhook/target 透传；`ConnectorHost` 把外部消息接到同一个 `SessionHost.run`；Telegram long-poll 支持 abort 停止；Feishu/Lark 默认走官方 SDK WebSocket 长连接（无需公网 webhook），高级模式保留 webhook token/signature、加密回调解密与文本收发；WeChat 对齐 Hermes 的腾讯 iLink Bot API 扫码登录 + long-poll，保存 sync/context token；webhook 入口在非 webhook transport 或缺少验证 secret 时拒绝。
- `apps/ui/src/settings/SettingsHost.tsx` — 设置页 page-host module：section registry、上次分区持久化、`ew:open-settings` 定向打开、visited keep-alive 与整页布局契约。`apps/ui/src/pages/Settings.tsx` 只是兼容 re-export。
- `apps/daemon/src/cli.ts` + `cli/*` — `easywork` CLI（既是 `serve` daemon 入口，也是终端瘦客户端 `repl`/`run`/`models`/`thread`/`mem`/`status`/`stop`）。`cli/daemon.ts` 自启/发现本机 daemon；`cli/agent.ts` 渲染 SSE 事件流（助手文本→stdout、装饰→stderr）。复用 `@ew/sdk` 打 HTTP，**后端零改动**（唯一例外：`models rm` 的 `POST /models/local/delete` + `ModelManager.deleteLocal`，含受管目录硬校验）。
- `packages/shared/src/*` — 核心契约（见下）。

## 核心契约（@ew/shared，OpenAI-shaped 为通用语言）

- `InferenceEngine`：`chat()` / `chatStream(): AsyncIterable<ChatStreamEvent>` / `embed?()` + `capabilities`。本地模型进程生命周期另由 `LocalBackend`（`load/unload/loadedIds`）管理。
- `ChatStreamEvent`：判别联合 `text-delta` / `tool-call-start|args-delta|end` / `reasoning-delta` / `usage` / `done` / `error`。**不用裸字符串流**（无法表达 text 与 tool call 交织）。
- `Tool` / `ToolProvider`：内置工具、MCP 工具统一成 `Tool`，再经 `toPiTool` 桥成 pi customTool（含 `ApprovalGate`）。**自研 `ToolRegistry`/agent loop 已删除**，agent 内核 = pi `AgentSession`。
- `MemoryProvider`：`recall/write/edit/list/delete/deleteBySession/deleteByScope/observe`（均带 `scope`）。本地 Core Memory = 全局 User Profile / Agent Notes（markdown 投影）+ 工作区 conventions / decisions / pitfalls（DB-only）+ source-owned derived facts；sqlite-vec 语义 ⊕ 词法混合召回。外部 provider 只能通过 `CreateCoreOptions.deepMemoryProvider` 由宿主注入，再由 `AdditiveMemoryProvider` 追加受限、不可信召回，永不接管写入；Desktop / CLI 当前没有配置入口，`Mem0MemoryProvider` 仍是非用户态适配骨架。
- `SkillCandidate` / `LearnedSkill`：foreground Learn、restricted background review、HTTP routes、Agent tools 与旧层迁移都只通过 `SkillCandidateLifecycle`；批准前验证 package/路径/symlink/工具/secret/injection/content hash，批准才原子写入全局或工作区 Skill source 并失效会话。learned Skills 可记录反馈、固定、快照、可恢复归档和回滚。
- `AgentEvent`（SSE 对外）：`text/reasoning/tool-start/tool-end/tool-progress/approval-request/memory-recall/usage/retry/compaction/artifacts/final/error`。`mapSessionEvent` 把 pi 事件映射到它；`artifacts` 由 `SessionHost.run` 在普通对话的 thread 串行边界内生成，并在成功持久化后由 `/agent/run` 发出。
- `ChannelAdapter` / `ChannelGateway` / `ChannelOperations`：平台 adapter 实现 `start/stop/send/handleWebhook?`，gateway 负责配置/状态/allowlist/webhook/出站 target；core 侧只通过 `ChannelOperations` 管理 gateway/host 生命周期、扫码 setup session、inbox read model 与失效事件。`ConnectorHost` 经 `resolveThreadForChannel(kind, channelUserId)` 映射渠道身份到 thread。渠道 secret 由 `ChannelSecretStore` 保存，SQLite 的 `im.connectors` 只保留非敏感配置；读取 API 的 `secrets` 恒为空，并以独立 read view 返回 `secretKeys`，空白编辑保留已存密钥，删除连接器同步删密钥。管理 API 走 daemon Bearer；外部 webhook 入口不要求内部 Bearer，需由平台 adapter 校验平台签名/secret；core 只为 webhook 捕获 raw body 供签名计算，并在读取前/读取中执行 32MiB 上限。Feishu/Lark 另有 `/im/feishu/register` 管理面扫码注册 helper，成功后自动保存 websocket connector；WeChat 另有 `/im/wechat/register`，对齐 Hermes 的腾讯 iLink QR 注册并保存 `accountId/token/baseUrl`；取消或 core stop 会 abort 未完成扫码会话。`/inbox/threads` 是基于现有 channel thread/message history 的只读 UI 聚合视图，不是第二套消息真相源；`/inbox/events` 只发 ready/changed 失效事件，前端收到后重新读取 read model，不做 4 秒轮询。旧 `ChannelConnector` 仍保留兼容测试和 Telegram long-poll 基础实现。

## 关键正确性约束（务必遵守）

> tool-call 解析/交织、调用去重、max-iterations 等**由 pi 内核负责**（自研 loop/healing 已删除）。以下是 EasyWork 宿主层必须守住的：

1. **每 thread 串行化 run**：`SessionHost.run` 用 promise 链按 threadId 串行——同一会话同时只跑一轮。pi 的 `subscribe` 是会话级，并发会跨请求串流 + 审批错配（IM 连发/双击/重连可触发）。
2. **事件映射唯一边界**：`mapSessionEvent`（pi→SSE）+ `pi-adapt.ts`（pi↔OpenAI/Anthropic）是仅有的边界翻译。协议翻译器必须处理 `error` 事件并正确终止（OpenAI error 帧 / Anthropic `event: error`，**不可伪装成 `end_turn`**）。
3. **工作区路径限定**：pi 自带 fs 工具**不做路径沙箱**（`write ../x` 会越界）。`escapesCwd`（`ew-extensions.ts`）经 `realpath` 解软链后硬拦 read/edit/write/ls/grep/find 越界（所有审批档位）；bash 靠审批把守。锁定测试：`workspace-confinement.test` + `permission.test`。
4. **0.0.0.0 暴露强制 api-key**：`RouterServerManager` 绑 0.0.0.0 时必须设 `--api-key`（`/settings/local-net` 校验，切换重启 router）；内部回环调用（pi/proxy/fact-extractor）一并带 Bearer；自连接恒走 127.0.0.1。
5. **Provider 模型身份、协议与目录继承**：云端 provider 模型在 EasyWork 内部使用 `provider:<providerId>:<modelId>` route id，`/models.modelSources[].modelId` 才是展示/上游真实模型名；进入 pi `ModelRegistry` 或上游前必须还原裸 `modelId`，避免自定义 provider 与内置 provider 的同名模型互相覆盖。有效 API / Base URL 按 `modelConfig` 覆盖 → provider 默认值解析，以支持同一聚合商内 OpenAI 与 Anthropic-only 模型并存；Anthropic SDK 会自行追加 `/v1/messages`，因此 runtime model 必须移除用户态 Base URL 末尾已有的 `/v1` 或 `/v1/messages`，保证界面预览与真实请求一致。自定义 OpenAI-compatible 未声明细粒度能力时使用保守 `compat`（例如 system role、`max_tokens`），不可假定支持 developer role。目录模板的名称、`reasoning`、`thinkingLevelMap` 与 `maxTokens` 可跨 API family 在运行时继承；上下文窗口与输入模态只在 UI 选定模板时复制并保存到模型配置，既有配置不会在运行时被覆盖。`compat` 是报文协议行为，只能在模板 API 与有效模型 API 一致时物化。云端思考报文字段由 pi-ai 按有效模型 API / compat 生成，`SessionHost` 只给本地 llama 注入 `chat_template_kwargs`，不得向全部云端模型统一塞 `thinking` / `reasoning_effort`。`modelSources[].reasoning` 是 Chat/Workspace 默认思考档位的能力来源，勿在 UI 里按 provider 名硬编码。
6. **SSE 健壮性**：所有 SSE 写口（`/agent/run`、`/v1` 透传、云端分支）须 `raw.on("error")` + `writableEnded/destroyed` 守卫，避免客户端断开后 write-after-end 崩 async handler。
7. **记忆召回**：相关度下限 + topK 上限防 context 稀释；markdown 为真相源、embedding 为派生缓存（变更才重嵌）；召回缓存挂 `RunRuntime`，每轮 `run()` 重置。
8. **sqlite-vec**：`vec0` 表 rowid 须 `BigInt`；`distance_metric=cosine`；扩展为可选依赖，无二进制时降级纯词法（勿让其抛错中断启动）。
9. **个人微信路线**：个人微信只走腾讯 iLink Bot API 的 bot 身份（扫码登录 + long-poll），不要回到 Web 微信/逆向普通号；群聊能力取决于 iLink 是否投递事件，默认关闭。企业微信仍走 WeCom。
10. **渠道密钥不落 SQLite**：新增/扫码/迁移得到的渠道 secret 必须先写 `ChannelSecretStore`；SQLite 不存 secret，GET 响应只返回字段名。安全存储失败不得清除旧明文或伪装成保存成功。
11. **Agent Turn 单一客户端生命周期**：Chat / Workspace 不得重新实现 `runAgent` 事件循环、审批、重试、停止或完成逻辑；差异经 `AgentTurnPolicy` 注入。
12. **Workbench 与 Terminal 生命周期分离**：SideDock 不持有工作台视图打开 / 关闭 / 导航规则，也不承载 terminal；Desktop PTY 只能由 `TerminalPanelSession` 恢复 / 创建 / 激活 / 关闭，并在对话区底部独立渲染。普通文件 / 浏览器 / diff 不跨应用重启持久化，只有 Desktop runtime 仍存在的 terminal 可重新附着。
13. **Source Conversation 删除屏障**：thread / Project 删除、空 shell 回滚与 run claim 必须经 `SourceConversationLifecycle`；所有 source-owned 清理同序完成，scratch 失败非致命，用户 workspace 永不删除。
14. **Skill Candidate 生命周期**：routes / tools / coordinator / migration 不得直接访问 candidate store；后台学习只生成 pending Candidate，只有显式批准可激活 Skill。

## 约定

- **统一 npm**（环境无 pnpm）。
- **测试 399 通过**（vitest；另 1 个真机 e2e 默认 skip）。另有 **Playwright UI e2e 46 条** 作为 CI 主跑层（真 daemon + 真 Vite + 隔离 data dir），以及 Windows NSIS 构建 + SEA `/health` 冒烟作为发布关键路径。`npm run lint` 当前 0 warning / 0 error。改 `@ew/core` / `@ew/sdk` 源码后，依赖其 `dist` 的下游（daemon 打包内联 dist）需 `npm run build` 才生效。
- **已移除 node-llama-cpp + 经典 `llama-server`**：本地推理走外部统一 `llama`（llama.app）的 router 模式（`resolveLlamaBin` 只解析 `llama`；嵌入子进程也跑 `llama serve`）。**勿重新引入** node-llama-cpp，也**勿回退每模型一进程的经典 `llama-server`**（含 brew llama.cpp，已完全移除）。
- **打包**：daemon → Node SEA **单文件二进制**（`scripts/build-daemon-sea.mjs`，运行免 Node；必须用参数化子进程调用，兼容 Windows 路径）；Tauri 的 `beforeBuildCommand` 会无条件重建 SEA，禁止把新 UI 与旧 sidecar 打进同一应用；llama 运行时缺失时经 [llama.app](https://llama.app) 自动安装（`resolve-llama.ts` + `/local/install-runtime` + `install.sh` / `install.ps1`）；Tauri WebView 启用显式 CSP；`v*` tag 先经 `release:check-version` 校验 npm/Tauri/Cargo 版本一致，再由 GitHub Actions 出 macOS dmg 与 Windows x64 NSIS/MSI。两端发布前必须跑 `smoke:daemon-sea`，Windows 还须跑 `release:check-artifacts`。
- **改 Tauri Rust（`apps/desktop/src-tauri`）**：本环境有 `cargo`，可 `cargo check` 验证。

## 常用命令

```bash
npm install            # 装依赖
npm run build          # turbo 构建全部包（含 ui/daemon dist）
npm test               # vitest（399 通过；另 1 个真机 e2e 默认 skip）
npm run test:coverage  # vitest coverage（line / branch / function / statement）
npm run e2e:install    # 安装 Playwright Chromium（首次一次）
npm run test:e2e       # Playwright UI e2e（隔离 data dir + 真 daemon + 真 Vite，CI 主跑这层；当前 46 条）
npm run typecheck      # 全量类型检查　·　npm run lint
npm run release:check-version # 校验发布清单版本一致
npm run smoke:daemon-sea      # 启动打包后的 SEA daemon 并验证 /health
npm run release:check-artifacts -- windows # 校验 Windows sidecar / vec0 / NSIS / MSI

# 真机 smoke（需本地模型 + 统一 llama；router 模式；默认不进 CI）
EW_E2E=1 npx vitest run packages/core/test/session-host.e2e.test.ts

# 开发
npm run dev:daemon     # 仅起 daemon（stdout 首行打印 {baseUrl,token,pid}）
npm run dev:ui         # Vite (5173)；浏览器连 daemon：http://localhost:5173/?baseUrl=<daemon>&token=<token>
npm run dev:desktop    # tauri dev：Rust 壳 + Vite + daemon sidecar

# 打包（需 cargo）
node scripts/build-daemon-sea.mjs           # daemon → 单文件二进制
npm run app:build --workspace @ew/desktop   # 当前平台安装包；Windows release 指定 --bundles nsis,msi

# 冒烟脚本
node scripts/smoke-local.mjs    # 下小模型 + 本地文本推理
node scripts/smoke-vision.mjs   # 视觉模型多模态问答
```

## 参考文件（只读，勿改）

- **pi 内核 API（可移植真相源）**：类型在 `node_modules/@earendil-works/{pi-coding-agent,pi-agent-core,pi-ai}/dist/*.d.ts` —— 写宿主代码时核对 `createAgentSession` / `AgentSession` / 事件 / 工具 / Model / extensions / auth-storage / model-registry 的形状。
  > 若本机另有 pi 源码 clone（路径因机器而异，自行定位），可读其 `packages/coding-agent/src/{core,index.ts}` 看实现；无则以上面 `node_modules` 的 `.d.ts` 为准。

> 注：agent loop / tool_healing / tool-registry 已由 pi 内核取代（自研实现已删除），**勿重新引入**。

## Agent skills

### Issue tracker

Issues and PRDs are tracked as local Markdown under `.scratch/`; external PRs are not a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five canonical triage labels plus the repository-specific `done` completion label. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: `CONTEXT.md` at the repository root and architectural decisions under `docs/adr/`. See `docs/agents/domain.md`.
