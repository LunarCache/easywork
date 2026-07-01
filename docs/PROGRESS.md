# 项目进展（PROGRESS）

> 每完成一个里程碑更新此文件。下方「状态总览」是滚动结论，再往下是按时间倒序的里程碑日志。

## 状态总览

### ✅ 已完成

- **核心守护进程**（`@ew/core`）：Fastify HTTP + SSE，托管 pi-coding-agent 内核（`SessionHost`，按 threadId 串行化），无头可运行（`easywork serve`）。
- **本地推理（router 模式）**：统一 `llama`（llama.app）的 `llama serve --models-dir` **单路由进程**，按请求 `model`（= 模型子目录名）路由、按需 auto-load、`--models-max` LRU 淘汰（文本 / 视觉）；嵌入模型走独立 `llama serve -m --embedding` 进程。经典每模型一进程的 `llama-server`（含 brew llama.cpp）**已完全移除**——只支持 llama.app 统一 `llama`。HF 搜索 / 断点续传下载 / GGUF 头解析。
- **云端推理**：OpenAI 兼容 provider（OpenAI / OpenRouter / DeepSeek / vLLM …），云端流式经 pi-ai（含 OAuth）。
- **多协议网关**：`/v1/chat/completions`（+stream）/ `/v1/embeddings` / `/v1/models`（OpenAI）+ `/v1/messages`（Anthropic）；本地透传、云端经 pi。
- **Agent 工具**：内置工具（time/calculator/http_get+SSRF/web_search）、MCP（stdio+HTTP）、Skills，全桥成 pi customTools；审批 4 档 + 工作区路径限定。
- **工作区模式**：本地项目目录读写文件 / 跑命令 + git 改动审阅面板；聊天模式工件目录。对话区与工作区共用右侧「工作台坞」（改动 / 文件 / 终端 / 预览）。
- **记忆（作用域化）**：全局池 + 每工作区私有池；渐进式披露注入 + 批量事实抽取；sqlite-vec ⊕ 词法混合召回；markdown 可手改回灌。
- **知识库 RAG**：上传 → 解析 → 分块 → 嵌入 → RRF 混合检索 + 引用来源。
- **思考过程持久化**：reasoning 落库并跨会话回放（不回喂模型）。
- **桌面 / UI**：Tauri 2 外壳（sidecar 拉起 daemon）+ React 前端（"Agent Tasks" 工作台设计语言，明暗双主题）；展开式侧栏（项目/对话分组）+ 三栏可拖拽 + 常驻「工作台」面板 + 整页设置（模型/渠道/知识库/Skills/MCP/记忆 内嵌）+ 统一弹层。
- **外部渠道**：`@ew/im-connectors` Channel Gateway（adapter registry + 配置/状态 + allowlist + webhook 分发），Telegram 已迁入同一抽象并支持可取消 long-poll；Discord / 企业微信 / 飞书待补平台 adapter。
- **存储**：`node:sqlite`（ConversationRepo + FTS5 全文检索 + 设置 / provider / MCP / IM 连接器持久化）。
- **命令行（CLI）**：`easywork` 既是 daemon 入口也是终端客户端 —— `repl`（交互多轮 + 工具审批 y/n + Ctrl-C 中断本轮）/ `run`（一次性，支持管道 stdin、`-t` 续接会话）/ `models ls·pull·rm` / `thread ls·show·rm` / `mem ls·search·rm` / `kb ls·search·add·rm` / `serve` / `status` / `stop`；自动拉起/发现本机 daemon，复用 `@ew/sdk` 打 HTTP；`EW_BASEURL` 可直连远端。
- **打包发布（macOS）**：daemon 打成单文件原生二进制（Node SEA，运行免 Node）；Tauri 出 dmg（Apple Silicon，内置 daemon + sqlite-vec）；`install.sh` 一键安装并自动备齐 llama 运行时（缺失经 llama.app 装）；`v*` tag 触发 GitHub Actions 构建 + 发布到 Releases。

### 🚧 待做

- **渠道 adapter**：Discord / 企业微信 / 飞书待补（需实盘凭证联调）；Channel Gateway 抽象和 Telegram adapter 已落地。个人微信无官方机器人 API → 仅做企业微信。
- **打包发布收尾**：macOS（Apple Silicon）dmg 已发；Intel / Windows / Linux 安装包 + 代码签名 / 公证 + 自动更新待做。
- **代码执行沙箱**：python / terminal 的独立 OS 级隔离（当前经 pi `bash` 工具 + 审批 4 档把守，无独立沙箱）。
- **密钥存储**：provider / MCP key 现存 SQLite `settings`，待迁 OS keychain（keytar / Tauri stronghold）。
- **工作区 v2**：多会话回放 / 提交历史 / push-pull / per-hunk 暂存均已完成；仅剩内嵌可编辑编辑器（按需）。

---

## 里程碑日志

## 2026-06-30 — Channel Gateway 抽象层落地

- **抽象层**：`@ew/shared` 扩展 `ChannelConfig/ChannelStatus/ChannelTarget/ChannelAdapterMeta/InboundMessage` 等契约；`@ew/im-connectors` 新增 `ChannelAdapter`、`ChannelAdapterRegistry`、`ChannelGateway`，把平台生命周期、状态、allowlist、webhook 和出站 target 统一收口。
- **Telegram 迁移**：保留旧 `TelegramConnector` 兼容测试，同时新增 `TelegramChannelAdapter` + `telegramAdapterEntry`，作为第一个内置 adapter。后续 Discord gateway、WeCom/Feishu callback 都注册进同一个 registry。
- **Core 接线**：`@ew/core` 装配 gateway + `ConnectorHost`，新增 `/im/adapters`、`/im/connectors` 管理路由、`/im/connectors/:id/start|stop` 生命周期路由和 `/im/:id/webhook` 分发入口；连接器配置持久化在 SQLite settings。
- **正确性**：`ChannelGateway.upsert/remove` 改为确定性等待旧 adapter 停止；Telegram long-poll 停止可 abort，不再等轮询超时；入站消息先过 `allowAll/allowedUsers/allowedChats`；回复保留 `channelThreadId/replyToMessageId` 等平台 target；管理 API 走 Bearer，外部 webhook 入口交给 adapter 做平台级校验。
- **UI**：设置页新增「渠道」分区，并从 `/im/adapters` 元数据生成可选平台，只展示已注册 adapter。
- **验证**：新增 core HTTP/persistence/webhook 测试、gateway allowlist/target 测试、Telegram long-poll abort 测试与 SDK 路由测试；`npm test` = **219 passed / 1 skipped**，相关 `@ew/shared`、`@ew/im-connectors`、`@ew/core`、`@ew/sdk`、`@ew/ui` typecheck 通过。

## 2026-06-28 — CI 友好的 Playwright UI e2e 扩容到 14 条

- **补齐 Playwright 测试基建**：加入 `playwright.config.ts` 与 `apps/ui/e2e/fixtures.ts`，每条用例都在**隔离 `EW_DATA_DIR`** 下启动真实 `apps/daemon/dist/cli.js serve`，再用真实 Vite UI 通过 `?baseUrl=...&token=...` 连入；这层可直接进 CI，不依赖本地模型。
- **把旧 core 真机 e2e 明确降级为 smoke**：`packages/core/test/session-host.e2e.test.ts` 保留，但文义与定位改成**本地/发布前 runtime smoke**，不再当作 CI 主层。
- **新增稳定测试锚点**：为 `Sidebar`、`SearchPalette`、`SlashPalette`、`ContextBar`、`FilesPage`、`ProjectFileTree`、`FileViewer`、`KnowledgeBaseOverlay`、`MemoryOverlay`、`Skills`，以及 Chat / Workspace 的关键 composer 节点补最小量 `data-testid`，避免把断言绑死在易变文案上。
- **第二层 e2e：设置与共享 composer**：
  - `apps/ui/e2e/settings.spec.ts`：设置页打开、返回后记住上次分区、本地/云端模型 tab、渠道页打开并记住分区、知识库/记忆页主操作可见。
  - `apps/ui/e2e/composer.spec.ts`：聊天/工作区 `+` 图片上传、聊天页 slash palette、工作区 `/think`、工作区审批策略切换与刷新后持久化。
- **MCP e2e 收口**：UI 端不再保留单独的 MCP Playwright 场景；`packages/core/test/session-host.e2e.test.ts` 继续只做 `SessionHost` 的 runtime smoke，不覆盖 MCP 配置/探测/工具流。
- **第三层 e2e：导航与切换**：
  - `apps/ui/e2e/navigation.spec.ts`：`⌃K` 全局搜索打开/筛选/回车切项目、工作区上下文条切项目、侧栏按钮打开搜索并用 `Esc` 关闭。
- **第四层 e2e：文件页与记忆真实写状态**：
  - `apps/ui/e2e/files-memory.spec.ts`：侧栏进入文件页 → 预览文件 → 返回任务；记忆页添加 / 编辑 / 搜索 / 删除闭环。
- **第五层 e2e：知识库与 Skills 管理**：
  - `apps/ui/e2e/kb-skills.spec.ts`：知识库已有文档的搜索 / 预览 / 删除；Skills 模板新建、列表出现、详情打开与返回。
- **顺手修掉真实浏览器路径 bug**：新增审批策略 e2e 时发现浏览器端 `PATCH /projects/:id` 会被 daemon CORS 预检拦掉（缺少 `PATCH`）；`packages/core/src/server/app.ts` 已放行 `PATCH`，连带修复项目审批策略与记忆编辑这类浏览器 PATCH 流程。
- **CI workflow 收口**：`.github/workflows/ci.yml` 从只跑 `settings.spec.ts` 升级为直接跑 `npm run test:e2e`，使整组 14 条 UI e2e 成为默认主跑层。
- **验证**：`npm run test:e2e -- apps/ui/e2e/settings.spec.ts apps/ui/e2e/composer.spec.ts apps/ui/e2e/navigation.spec.ts apps/ui/e2e/files-memory.spec.ts apps/ui/e2e/kb-skills.spec.ts` → **14 passed**。

## 2026-06-27 — UI 一致性收口（composer / slash / 设置记忆 / 运行态拆分）

- **聊天页入口更明确**：`Chat.tsx` 空态补一排快捷动作卡片（联网搜索 / 打开工作区 / 配置模型），把「直接提问」和「进入工作区做项目」两条路径讲清楚；点击后分别预填搜索提示、打开工作区创建流、直达设置里的模型分区。
- **Chat / Workspace composer 统一成“前置运行态”**：聊天页新增 `ComposerContextStrip`，把 **模型 / 思考 / 联网 / 知识库 / 上下文压力**提到输入框上方；工作区把 `ContextBar` 扩成可接 children，把 **项目 / 分支 / 模型 / 思考 / 上下文压力**并到一行。`App.tsx` 也把 `contexts` 继续传进 `Workspace`，让历史线程回填 usage 后能算出正确百分比。
- **`+` 按钮去重收口**：顶部状态条已经能直接改模型 / 思考 / 联网 / 知识库后，聊天与工作区的 `+` 不再展开重复菜单，统一退化为**上传图片**单一动作；工作区审批策略继续留在右侧常驻 pill。
- **斜杠命令面板升级**：`SlashPalette.tsx` 改成两阶段 command palette 风格——头部显示当前阶段，列表右侧展示当前值 / 当前项，`/compact` 会带上当前上下文占比。`lib/slash.ts` 也补上 `THINK_META`，把文案与运行态标签统一起来。
- **设置页记住上次分区**：`App.tsx` 把 `SettingsSection` 提升为应用级状态并持久化到 localStorage；`Settings.tsx` 新增 `initialSection` + `onSectionChange`，从聊天/工作区打开设置时可直达指定分区，返回后再次进入会回到上次停留位置。原有各 pane 继续保持挂载，避免切页引发知识库/记忆页面状态丢失或黑屏回归。
- **原生 alert/confirm 收口到应用弹层**：`useConfirm()` 扩展 `alert()`，替换 `App.tsx` 与 `SideDock.tsx` 中的原生 `alert/confirm`，让新建工作区、删除项目/会话、git 提交失败提示都走同一套 UI。
- **开始拆薄运行态逻辑**：抽出共享 hooks / helper，减少 `Chat.tsx` 与 `Workspace.tsx` 的重复：
  - `hooks/useAvailableModel.ts`：模型变更时自动纠正当前选中值
  - `hooks/useComposerImages.ts`：图片附件选择与 base64 转换
  - `hooks/useMessageScroll.ts`：消息区自动滚底 / 跳到最新
  - `lib/composer.ts`：textarea 自适应高度、重置、聚焦尾部
  - `lib/message-runtime.ts`：用户轮次拼装、重新生成替换、取消、末条用户查找
- **验证**：`npm run typecheck --workspace @ew/ui`、`npm run build --workspace @ew/ui` 通过；在 in-app browser 实测了设置页「记住上次分区」、聊天 / 工作区顶部运行态状态条、升级后的 slash 面板，以及 `+` 号已退化为单一上传动作，确认设置页黑屏未回归。

## 2026-06-25（续3）— 消息交互（复制/重试/编辑/重新生成）+ 思考开关真关

- **代码块**：`pre` 覆写 `CodeBlock`，顶栏语言标签 + 复制（取高亮 span 树纯文本）；内联代码不受影响。
- **消息操作行**（下移，取代右上悬浮）：助手下方复制整条；用户末条下方编辑 + 重试。
- **重新生成**（重试/编辑共用）：后端 `regenerate` → `rollbackLastUserTurn` 用 pi `navigateTree` 回滚上一轮（旧问答分叉离开上下文，含 JSONL/resume 正确）；前端替换旧答案非追加、composer 不动。修复 bug：重试漏推 `history` 致后端取到空 text、模型「以为用户没说话」——`history` 始终带原文。
- **思考开关真关**：之前 `off` 仍思考。根因——用错了参数键。修复：**云端**注入 `thinking:{type:"enabled"/"disabled"}` + `reasoning_effort`（DeepSeek-V4 等 OpenAI-SDK 思考模型的扩展，off 真关、省 reasoning token）；**本地**用 llama.cpp 的 `chat_template_kwargs.enable_thinking` + `thinking_budget_tokens`。实测 deepseek `off`→reasoning 0、`high`→reasoning 正常。
- **代码块复制 bug**：复制源取自 highlight.js 高亮后的 span 树纯文本，确保是干净源码。
- 测试 **212 通过**（+ injectCloudThinking / mapSessionEvent error 等）· typecheck 19/19 · lint 0 · build 绿；Playwright 逐项验证（代码块、复制/重试/编辑、上下文回滚、思考开关）。

## 2026-06-25（续2）— 修复云端模型「没有输出」（工具 schema 兼容 + 错误不再被吞）

DeepSeek 等严格 provider 下 `/agent/run` 整轮空输出。根因 + 修复：
- **工具 schema 方言**（`packages/tools/src/define.ts`）：`zodToJsonSchema` 用 `target:"openApi3"` 把 `z.number().int().positive()` 译成 **draft-4 布尔 `exclusiveMinimum:true`**；OpenAI 宽容接受，但 DeepSeek 按 draft-7 校验 → `400 Invalid schema for function 'recall_memory': true is not of type "number"` → 整轮 400。改 `target:"jsonSchema7"`（numeric exclusiveMinimum，OpenAI/Anthropic/llama.cpp 通用）。`/v1` 网关不带工具故不受影响——这也是为何 `/v1` 能跑、agent loop 不能。**既存 bug，与新功能无关。**
- **错误被吞**（`session-host.ts` mapSessionEvent）：provider 在 agent loop 内报错时，pi 以 `agent_end` 末条 assistant `stopReason:"error"`+`errorMessage` 收尾（非流式 error delta），原映射只发空 `final` → 用户「没有输出」却看不到原因。现 `agent_end` 检测末条 assistant error → 冒泡 `error` 事件。
- 顺带：prompt caching 收紧到**仅 Anthropic-shaped API**（`cacheRetention`/`sessionId` 是 Anthropic 语义，不发给 OpenAI 兼容 provider）。
- 实测 DeepSeek 真机正常流式；测试 **210 通过**（+错误冒泡单测）· typecheck 19/19 · lint 0 · build 绿。

## 2026-06-25（续）— 接入 pi 内核 6 项能力（斜杠命令 / 分级思考 / 切模型 / 压缩 / 重试 / 缓存）

把 pi-coding-agent 已有但未启用的能力接进宿主层。全部用 pi `.d.ts` 核验后实现，后端 + 双 composer。

- **分级思考**：去掉硬编码 `thinkingLevel:"off"`；每轮 `setThinkingLevel`（云端 reasoning 模型真分级）；**本地**经 `injectLocalThinking` 往 llama.cpp 请求体注入 `chat_template_kwargs.enable_thinking` + `thinking_budget_tokens`（取代旧 Qwen `/think` 文本 hack）。对外 4 档 off/low/medium/high。
- **自动重试**：`setAutoRetryEnabled(true)` 默认开；`auto_retry_start` → `retry` 事件，状态条提示"重试中"。
- **prompt caching**：streamFn 包装对**云端**加 `cacheRetention:"long"` + `sessionId=threadId`（会话级缓存）。
- **手动压缩**：`SessionHost.compact(threadId)`（排进该 thread 的 runChain 串行）+ `POST /threads/:id/compact` + SDK `compactThread`；`compaction_start/end` → `compaction` 事件。
- **斜杠命令**：`lib/slash.ts` + `useSlashPalette`（两 composer 共用）——输入「/」两阶段自动补全：`/think <档位>`、`/model <名>`、`/compact`。
- **思考控件**：composer `think` 布尔 → `thinkingLevel` 分级 chip（按模型持久化，默认 off）；Chat + Workspace 双 composer。
- 契约：`AgentEvent` 加 `retry`/`compaction`（含 `ok`）；运行入参 `think:boolean` → `thinkingLevel`。
- **多 agent 高强度审查（38 agent）发现并修复 6 类真 bug**：① 自动重试/压缩会先发 `agent_end{willRetry}`，原逻辑会提前终止本轮吞掉续写 → 仅 `!willRetry` 才收尾、且不发提前 final；② `compact()` 在 runChain 屏障前读 session，换模型重建后会动到已 dispose 的旧会话 → 改为屏障后再读；③ 压缩总结调用继承上轮采样（小 maxTokens 截断总结）→ compact 前清 sampling/思考；④ 压缩中止/失败被谎报「已压缩」→ 加 `ok` 标记，UI 显「压缩未完成」；⑤ 重试/压缩瞬态提示仅靠后续 text 清除，以工具/错误结尾会残留 → 本轮 finally 清除；⑥ 本地思考改 payload 注入有版本风险 → 保留 `/think`·`/no_think` 文本兜底（仅本地）。
- 测试 **209 通过**（+5：mapSessionEvent retry/compaction(ok)/willRetry + injectLocalThinking）· typecheck 19/19 · lint 0 · build 绿；Playwright 实测斜杠面板/思考档/`/compact` 全通。
- **待真机校准**：本地思考的 llama body 字段接受性需文本模型实跑确认（payload 形状已单测锁定，且有 `/think` 文本兜底）。

## 2026-06-25 — 完全移除经典 `llama-server` 支持（仅 llama.app 统一 `llama`）

本地推理早已迁到 router 模式（`llama serve`），经典每模型一进程的 `llama-server`（含 `brew install llama.cpp`）只剩"探测回退"残留。本次**彻底移除**该回退与相关命名，运行时唯一真相 = llama.app 的统一 `llama`。

- **运行时解析**：`resolve-llama.ts` 删 `LlamaKind`/`kind`/`llama-server` 候选 → `resolveLlamaBin()` 只找 `llama`，返回路径字符串；`app.ts` 去掉 `kind==="llama"` 门槛，直接把 binaryPath 传给 router/嵌入。
- **引擎重命名**：`LlamaServerEngine` → **`LlamaServeEngine`**（`providers/llama-server.ts` → `llama-serve.ts`），`start()` 恒用 `llama serve`（删经典分支，默认二进制 `llama`）。该引擎现仅用于本地 embedding 子进程。
- **环境变量/选项**：`EW_LLAMA_SERVER` → `EW_LLAMA_BIN`；`createCore` 选项 `llamaServerPath` → `llamaBinPath`。
- **API/UI**：`/local/runtime` 与 SDK `runtimeStatus()`/`installRuntime()` 去掉 `kind` 字段；Models 页运行时缺失提示文案去 `llama-server`。
- **注释收口**：本地透传/网络暴露注释 `llama-server` → `router`，采样/Harmony 扩展 → `llama.cpp`，嵌入 → `llama serve`。
- 测试 **212 通过**（e2e 仍 skip）· typecheck 19/19 · lint 0 · build 绿。

## 2026-06-24（续）— 设置整页化 + 插件并入设置 + 弹层统一 + 本地模型删除

`feat/kb-redesign` 合回 main 后的一批 UI 一致性收口（纯 `apps/ui` + `@ew/core` 一个删除端点）。

- **设置整页化 + 插件并入**：设置从弹层（`PageOverlay`）改为**整页内嵌**，左导航 8 项（通用 / 模型 / 知识库 / Skills / MCP / 记忆 / 向量记忆 / 本地网络）；删除 `PluginsView`，5 个管理页以 keep-alive 内嵌进设置；去掉侧栏「插件」入口 + `Mode "plugins"`。通用 / 向量记忆 / 本地网络改 ZCode 式卡片行（标题+说明左、控件右）；向量记忆精简为紧凑状态行。
- **回归修复（多 agent 审查发现）**：设置整页化曾会卸载 Chat/Workspace 而中断在途流式运行并丢整轮 → 改为 `.ad-body` 始终挂载、CSS 隐藏；设置打开时隐藏工作台开关。
- **弹层统一**：新增 `useConfirm` hook + `ConfirmDialog`（替代 Tauri 不可靠的 `window.confirm`）。确认类（模型/知识库/MCP 删除）→ `useConfirm`；记忆添加输入 → `.confirm-box.wide`；KB 上传目标选择 → `.confirm-box.list-box`。删除全部自研 `.kb-confirm`/`.kb-pick` 弹层与 KB 删除原生 `alert`；`useConfirm` 修复并发重入 promise 泄漏。
- **本地模型删除**：模型页加删除按钮（hover 显形）+ 嵌入模型分级提示；后端 `/models/local/delete` 删的若是当前向量记忆引擎模型则一并停嵌入进程 + 清持久化设置（否则状态卡「运行中」）。
- **死代码清理**：`PageOverlay`、`PluginsView`、`.plugins-*`/`.appearance-*`/`.kb-confirm*`/旧 `.kb-pick` 外壳 CSS。
- 测试 **212 通过** · typecheck 19/19 · lint 0 error · UI build 绿（Playwright 逐项验证）。提交 `478f1c0`。

## 2026-06-24 — 知识库 / 记忆页重设计 + MCP 增强 + 审查修复（feat/kb-redesign）

基于 v0.4.0 后的 main 分出 `feat/kb-redesign`，重做知识库与记忆页、增强 MCP，并对改动做功能审查修复。纯 `apps/ui` + `@ew/mcp`，后端契约不变。

- **知识库页重设计**：左集合栏（每集合计数 + 处理中指示）+ 右文档卡片网格 + 文档预览（md 渲染 / 纯文本）；顶部上传先选目标集合、行内新建集合（名规范化，集合在有文件那一刻诞生）；ingest job 进度轮询（切 Tab keep-alive 不中断）。
- **记忆页重设计（档案 Dossier）**：左作用域栏（全局 / 你 + 各工作区，带计数）+ 右按层分区（层语义色 + 行内添加）；记忆卡带**来源徽章**（手动 / 自动抽取，按有无 sessionId 区分）+ 相对时间 + 行内编辑 / 删除；顶部**搜索**（作用域内过滤）+ 向量召回状态；空作用域 / 空层可从「+ 添加」选目标加第一条。
- **MCP 增强**：连接探测（带超时）+ 工具清单预览 + 编辑已有服务器配置 + 探测失败错误详情；`callTool` 透传 AbortSignal（+3 单测）。
- **去三色主题切换**（accent 不再切换，default blue）；Settings / prefs / ContextRing 收口。
- **功能审查修复**（多 agent 并行评审 + 逐项读码核实）：
  - MCP 取消信号**实际接上** —— `tools(ctx).execute` 改用每次调用的 `ctx.signal`，而非 provider 级的占位 dummy（原先取消/超时无法中断在途 MCP 调用）。
  - MCP 编辑保留表单未覆盖字段（http `useOAuth` / stdio `env` / 自定义 `displayName`），不再静默丢失。
  - MCP probe 超时定时器泄漏 → 抽 `withTimeout()`，`finally(clearTimeout)`。
  - 知识库：选中集合失效（最后一篇删除掉出列表）回落第一个、快速切文档预览加时序保护（`docReqRef`）、删除失败有反馈。
  - 记忆：补上空作用域 / 空层的常驻添加入口（弹层内可选 scope / 层）。
- 测试 **212 通过** · typecheck 19/19 · lint 0 error · UI build 绿。

## 2026-06-23（续2）— 功能审查修复（多模态 / 审批竞态 / UI 逻辑收口）

对前端重构后的各部分做功能审查（多 agent 并行评审 + 逐项读码核实），修复确认的逻辑错误与疏漏，后端最小改动打通图片多模态：

- **图片多模态彻底打通（严重）**：Agent 聊天的图片上传此前三层静默丢弃（`messageText` 剥文本 / `session.prompt(text)` 不传图 / 本地模型 `input:["text"]`），模型从未收到图。修复：`EwAgentRunInput.images` + `session.prompt(text,{images})` 透传 + 本地/云端模型 `input` 标记 image-capable（pi 仅在实际附图时下发，纯文本路径不变）；`app.ts` 从本轮用户消息抽 image parts。多轮历史的图由 pi 按 threadId 自持上下文随之生效。
- **Workspace 审批档位「切档即发送」竞态**：`setMode` 记录在途 PATCH，`send()` 前 `await`（服务端按 `project.approvalMode` 把守，避免用旧档位）。
- **SideDock 视图被后台 git 刷新打断**：`repo` 经 ref 读，effect 只依赖 `target.nonce`，git 状态刷新不再把用户从终端/预览拽回 diff。
- **统计修正**：files-changed 汇总卡过滤 `+0 −0` 幽灵行；`str_replace` 的 +/- 改 `lineDiffStat` 行级 diff（不再「改 1 行报 +N −N」虚高）。
- **filetype** 整名匹配 dotfile/无扩展名（`.gitignore`→GIT 等），消除 `GITI`/`MAKE` 乱码徽章。
- **PluginsView** 改 lazy keep-alive，知识库上传/索引进度轮询不再因切 Tab 中断。
- **侧栏/外壳**：⌘N 绑全局 keydown（原死快捷键）；空工作区/文件页隐藏工作台开关；删当前工作区会话切到下一个剩余会话；首屏选项目补拉会话定位最近会话。
- **记忆/知识库**：`MemoryOverlay` 接上 `editMemory`（行内编辑）+ `clearMemoryScope`（清空作用域）；KB 新建集合名规范化为合法 kbId + 空名拒绝 + 重名直接选中。
- 测试 201 通过 · typecheck 19/19 · lint 0 error · UI build 绿。

## 2026-06-23（续）— 前端整体重构为 "Agent Tasks" 深色设计（dark-only）

把桌面 UI 从「冷灰 + 靛蓝、明暗双主题」整体重构为 claude.ai/design 产出的 IDE/终端味 **Agent Tasks** 深色设计（经 DesignSync 连接器读取设计稿 + Qwen3-4B 真机会话逐屏验证）。后端零改动，纯 `apps/ui` + 一处 `tauri.conf`。

- **Token / 主题**：`styles.css` 以 Design Spec 深色 token 为默认（`--bg #0D0E12`…）+ 浅色 `[data-theme=light]` 覆盖（明暗双主题 + 跟随系统）；新增 `[data-accent=blue|iris|violet]`，旧 `--color-*`/`--surface`/`--accent` 别名重定向 → 存量组件随主题自动切换；移除 teal/amber/density。标题栏升 46px。
- **外壳**：两段式 `Titlebar`（段 A 侧栏宽 + nav，段 B 面包屑 + 工作台动态开关，状态由 App 提升）；展开式 `Sidebar`（新对话/打开工作区/收件箱/插件 + 项目/对话分区 + 设置 + 状态点）合并并删除 `IconRail` + `SessionList`。
- **插件页** `PluginsView`：点「插件」在主区打开标签页，模型/知识库/Skills/MCP/记忆 内嵌渲染（KB/记忆浮层加 `embedded` 去遮罩）。
- **对话**：AI 无头像纯 prose、用户 `acc-weak` 软气泡；**行内工具调用**（思考/编辑〔类型角标 +/-〕/运行/读取/搜索，点击展开）；**文件改动汇总卡**（`aggregateEdits` + `editStat`/`diffStat`/`lineDiffStat`，无 unified diff 时从 before/after 或 args 兜底算行数）+ 点击跳转工作台对应文件 diff。
- **工作台面板**：滑入 dock 改**常驻列** + **启动菜单**（改动/文件/浏览器/终端 大行）；toggle 上移标题栏（`dockOpen`/`dockTarget` 提升到 App）。
- **composer**：模型选择 + 用量环 + 参数移入底栏（弹出向上）；`+` 菜单收纳 思考/联网/知识库 开关 → 保持单行、优雅换行。
- **文件类型体系** `lib/filetype.ts`：扩展名 → 角标文字 + 品牌色 + lucide 图标，工具行/知识库/文件树统一；全局图标描边 1.8。
- typecheck 19/19 · lint 0 error · `npm run build` 绿。文档（FEATURES）同步。版本拟 0.3.0 → 0.4.0（大 UI 架构变更）。

## 2026-06-23 — 桌面窗口外观（macOS Overlay）+ 知识库集合 + UI 一致性收口

- **窗口系统按钮内嵌**：桌面端改用 Tauri `titleBarStyle: Overlay` + `hiddenTitle` + `trafficLightPosition`，macOS 原生红绿灯交通灯直接嵌进应用标题栏（与 EasyWork 字标垂直对齐 y=20），不再外包一层系统标题栏；`.is-desktop` 给标题栏留 88px 左内边距避让交通灯。
- **知识库新建集合**：知识库浮层「集合」标题栏加「+ 新建集合」入口（本地暂存空集合，上传第一篇文档后由后端 `kbList` 接管）；上传按钮 title 标明目标集合，消除「文件进了哪个分类」歧义。
- **UI 一致性收口**：Models / Skills / MCP 三页头部动作按钮统一为**图标 + tooltip**（打开目录 / 新建 / 下载模型 / 添加 Provider / 添加服务器）；浮层统一收窄 700px、按内容自适应高度；工作台坞图标换 PanelRight。
- **设置精简**：移除已失效的密度调节（紧凑/舒适）+ 各分区冗余说明文字，外观区改单列，减少空白。
- **向量记忆入口**：补上此前缺失的应用内开关——设置加「向量记忆」区块（状态 + 一键启用 `enableEmbedding`，下载 nomic-embed + 重建索引）；模型页嵌入卡状态改读独立 `embeddingStatus()`（与 router 分离），就绪显示「运行中 / 已启用」，两页同步。
- 自绘 `ModelSelect` 下拉替换原生 `<select>`（承接续5）。UI build 绿、lint 0 error。

## 2026-06-22（续5）— 本地推理完整迁移到 llama.cpp Router 模式（统一三端 = llama.app 的 `llama`）

把本地推理从「每模型一个 `llama serve -m` 进程 + 自研路由/LRU」**完整迁移**到 llama.cpp 的 router 模式（先查官方文档 + 本机实测确认能力，再分 10 步落地）。决策：① 完全弃用经典 `llama-server`/brew llama.cpp，三端统一 llama.app 的 `llama`；② 嵌入模型保持独立专用进程。

- **核心 `RouterServerManager`**（替代 `LocalServerManager`，实现新 `LocalBackend` 接口）：起 1 个 `llama serve --models-dir <modelsDir> --models-max N --models-autoload --host --port [--api-key]` 路由进程；`syncRoutes()` 拉 `GET /v1/models`，对每个（非嵌入）模型注册一个**强制 `model=routerId` 的包装引擎**到 registry；`load`/`unload` 走 `POST /v1/models/load|unload`（/v1 + 裸路径双探），`applyNet`(0.0.0.0+key) 重启单个 router。
- **模型身份**：router 按「子目录名」路由 ⇒ 规范 id = `routerId`（= `safeRepoDir(repoId)`，与下载建目录同变换）。`LocalModel` 加 `routerId`（`id`/`path` 仍为文件路径供下载/删除）；`routedModels()`/下拉/agent `model` 一律用 routerId；UI「运行中」按 routerId 匹配。
- **嵌入不动**：`EmbeddingService` 仍独立 `llama serve -m --embedding`（不进 registry/router），记忆/KB 链路零改；router 列表按 arch/名称启发式过滤掉嵌入模型。
- **弃用经典路径**：`resolve-llama` 改为优先统一 `llama`；删除 `LocalServerManager` + `local-lru`/`local-bind` 测试；install.sh/ps1 只认统一 `llama`。
- **真机 e2e 验证**：`llama serve --models-dir` 真实跑通 spawn → load（按子目录名）→ 工具循环（read）→ `final`；上下文从 GGUF 读到 40960。新 `router-server-manager.test`（注入 spawn/fetch，4 项）+ createCore 后端选择单测。typecheck 19/19 · lint 0 error · `npm test` 201 passed。
- **UI 修复**：① 模型卸载后 `models` 变空时校正 Chat/Workspace 的选中态（旧值残留导致状态点常绿 + select 渲染异常的潜在 bug）；② 模型下拉从原生 `<select>` 换成自定义 `ModelSelect`（弹出菜单 + accent 高亮 + ✓，与 Agent Desk 一致）。
- 文档（README/FEATURES/ARCHITECTURE/CLAUDE）全部改为 router 模式表述。版本 0.2.0 → 0.3.0（架构变更 + 需统一 `llama`，对旧安装为破坏性）。

## 2026-06-22（续3）— CLI 补全：models rm / thread / mem / kb + 会话续接 + Ctrl-C 中断

在 MVP 之上补齐管理类子命令与续接能力。除 `models rm` 需新增后端删除能力外，其余全部复用既有 SDK 方法（后端零改动）。

- **`models rm <名/片段>`**：唯一需碰后端的功能。`ModelManager.deleteLocal(id)` —— 路径硬校验必须落在 modelsDir/extraDirs 内（拒绝越界，realpath 解析）；删主文件及全部分片，repo 目录无其它模型时整删（连带共享 mmproj）。`POST /models/local/delete` 先 `local.unload(id)` 再删文件；SDK `deleteLocalModel`。CLI 按名/路径片段模糊匹配 + 多义报错 + 删除确认（`-y` 跳过）。
- **`thread ls / show <id> / rm <id>`**：会话列表 / 历史回放 / 删除（复用 `listThreads`/`threadMessages`/`deleteThread`）。
- **`mem ls / search <词> / rm <id>`**：记忆列表（`--scope` 限定）/ 召回（带分数）/ 删除。
- **`kb ls / search <词> / add <文件\|文本> / rm <docId>`**：知识库；`add` 文件走 base64 上传 + 轮询解析任务到完成，内联文本走 `kbIngest`。
- **会话续接**：`run`/`repl` 加 `-t/--thread <id>`。利用「daemon 只把最后一条用户消息喂给 pi、其余由 pi 持久化会话恢复」，续接只需传 threadId + 新消息。
- **Ctrl-C 中断本轮**：REPL 每轮一个 AbortController，SIGINT 仅 abort 当前轮（runTurn 捕获 AbortError 优雅收尾），不退出 REPL；空闲提示符下 Ctrl-C 才退出。
- **实跑验证**（临时 `EW_DATA_DIR`）：各子命令空态/错误路径；`kb add` 内联文本端到端入库；**`models rm` 越界护栏**（`/etc/passwd`、`/tmp/x.gguf` 均 400 拒绝、诱饵文件未删）+ 正向删除（受管目录内模型删除 + 空 repo 目录连带 mmproj 清理）；typecheck + eslint 全绿；`npm test` 204 通过；无孤儿进程。

## 2026-06-22（续2）— 命令行客户端（CLI）：repl / run / models / serve / status / stop

把 `easywork` 从「只有 serve 的服务端入口」扩成**真正的终端客户端**（瘦客户端定位：复用 `@ew/sdk` 打 daemon HTTP，后端零改动）。

- **命令树**：`repl`（无命令 + TTY 时默认）/ `run <提问>`（一次性，流式）/ `models [ls|pull]` / `serve` / `status` / `stop` / `--help` / `--version`。手搓零依赖 dispatch（SEA 友好），拆到 `apps/daemon/src/cli/`：`env`（SEA argv 适配 + 版本注入）、`daemon`（自启/发现）、`term`（TTY/上色/问询）、`agent`（事件渲染 + runTurn + 选模型 + 项目解析）、`commands/*`。
- **自动拉起 daemon**：`ensureDaemon()` 读 `~/.easywork/daemon.json` + `/health` 探活；死了且 autostart → detached spawn 自己 `serve`，轮询到就绪。`EW_BASEURL`/`EW_TOKEN` 可直连远端（不自启）。
- **流式渲染约定**：助手文本走 **stdout**（管道可干净捕获），工具调用 / 思考 / 状态 / 审批等装饰走 **stderr**；`approval-request` 在 TTY 弹 y/n/a，`--yes` 自动批准。`run` 支持管道 stdin 作提问。
- **SEA argv 适配**：SEA 单文件无脚本路径、真实参数从 `argv[1]` 起 → 构建期 `__EW_SEA__` define 区分 slice(1)/slice(2)；`__EW_VERSION__` 从根 package.json 注入，`--version` 在二进制里也准。
- **实跑验证**（临时 `EW_DATA_DIR` 免污染真实数据）：`--version`/`--help`；`models` 触发自启→列空→退出 0；`status` 显示地址/pid/模型；`stop` SIGTERM→`status` 转「未运行」；`run`/管道 stdin 在无模型时优雅报错退 1；typecheck + eslint 全绿，无孤儿进程。

## 2026-06-22（续）— 打包发布阶段：llama 运行时整合 + 单文件 daemon + macOS dmg + 一键安装

让 EasyWork 可分发：免 Node 依赖、内置/引导 llama 运行时、出 macOS 安装包、`curl|sh` 一键装。分四步落地，每步实跑验证。

- **P1 llama 运行时整合**：支持 llama.app 的统一 `llama` 二进制（经 `llama serve`，flag 与 `llama-server` 实测完全一致：`-m/--host/--port/--jinja/--embedding/--mmproj/-ngl/--api-key/-c/--pooling`）+ 兼容经典 `llama-server`。`resolve-llama.ts` 解析顺序 `EW_LLAMA_SERVER → llama-server → llama`（含 `~/.local/bin`/`/opt/homebrew/bin`，GUI 应用 PATH 很少）；缺失时 `GET /local/runtime` 状态 + `POST /local/install-runtime`（跑官方脚本）+ Models 页运行时状态条/一键安装。
- **P2 daemon 单文件二进制（Node SEA）**：bun 因不支持 `node:sqlite` 排除。`tsup.sea.config.ts` 把 cli + 全部依赖内联成单 CJS bundle（`splitting:false`；SEA main 须 CJS；`import.meta.url` 经 define+banner 顶替）；`scripts/build-daemon-sea.mjs` 做 bundle→SEA blob→注入 node 副本→macOS ad-hoc 重签→随附 `vec0.dylib`。`resolveVecExtensionPath` 加 `EW_SQLITE_VEC` + 可执行文件同目录回退（SEA 无 node_modules）。实跑 `easywork serve`（Mach-O arm64，无 node）→ /health ok。
- **P3 Tauri 打包（macOS）**：`lib.rs` 改为 spawn 随附的 `daemon/easywork`（开发仍 `node $EW_DAEMON_ENTRY`）；`tauri.conf.json` resources 随附 dist-sea；版本 0.0.0→0.1.0。实跑 `tauri build` → `EasyWork_0.1.0_aarch64.dmg`(48MB) + `.app`（Resources/daemon 含 157MB easywork + vec0.dylib）；启动打包 .app → 外壳 spawn 随附 `easywork serve`（非 node）→ /health ok，**全程零 Node 依赖**。
- **P4 一键安装 + Release CI**：`install.sh`（macOS：按架构从主仓公开 Releases 拉 dmg → 装 /Applications → 去 quarantine）/`install.ps1`（Windows 占位）；`.github/workflows/release.yml`（打 `v*` tag → macOS 双架构 runner → dmg 发 Release）。仓库已设公开 → `curl -LsSf .../install.sh | sh` 可直跑。
- 初版**未签名**（ad-hoc，文档说明 Gatekeeper 绕过）；Apple 证书/公证 + Windows/Linux + 自动更新为后续。

## 2026-06-22 — 依赖升级 + 对话区细节打磨 + 上下文窗口配置

延续 Agent Desk 一轮收尾：升级内核与工具链、统一对话区卡片与消息样式、补齐上下文用量显示，并让上下文窗口可按模型确定/配置。

- **依赖维护**：pi 三包 `0.79.3 → 0.79.9`（同 minor 补丁，API 形状不变、源码零改动）；清零 5 个 dev 工具链传递依赖漏洞（vite 5→7 修 HIGH、vitest 2→4 修 CRITICAL、@vitejs/plugin-react 4→5、`overrides esbuild 0.27.2`），`npm audit` 0 漏洞。
- **思考 / web_search 统一为工具卡**：reasoning→`THINK` 卡、web_search→`SEARCH` 卡，与 READ/EDIT/RUN 同套 `cv-tool` 折叠卡（图标 + mono 大写标签 + 状态 pill + chevron + 折叠体）。
- **消息样式**：用户消息改强调色实心气泡（去头像，`You` + 时间戳右对齐），助手名 → `AI assistant`；UiMsg 加 `at`。
- **上下文用量进度环**：composer 内 `ContextRing`（已用占比，越界变琥珀/红），替代 header 横条。修 bug：切换会话漏重置 `usage` → 进度环串号；现切换即清空。打开历史长会话回填用量：`SessionHost.lastUsage` 读 pi 会话日志最后一条 assistant 的 usage，端点 `GET /threads/:id/usage` + SDK `threadUsage`。口径修正：`promptTokens = input + cacheRead + cacheWrite`（prompt cache 活跃时只取 input 会严重低估），实时映射与历史回填统一。
- **网页内联预览修 bug**（并入工作台坞「预览」tab）：Tauri webview 里 `target=_blank` 会把整个 app 导航走且回不来；`MessageStream` 统一拦截来源 chip + markdown 外链 → 右侧预览。
- **上下文窗口确定/配置**：① 本地加载默认用模型**原生最大上下文**（GGUF `context_length`，去掉 8192 封顶；Qwen3-4B 同份 ~2580 token 系统提示词占比 31%→~8%）。② 云端 provider 新增**手动上下文窗口**（`CloudProviderConfig.contextWindow`：表单输入 → 持久化 → pi compaction 阈值 + `/models` context 映射 + 进度环），缺省 32768。
  - 诊断点：对话区「31% 占比」来自每轮固定 preamble（pi coding-agent 系统提示词 + 全部工具 schema + 记忆清单 ~2580 token），非用户输入；对话模式也加载完整编码工具集。
- 杂项：去标题栏装饰性假交通灯点；`spike-session.mjs` 空 catch 补注释（`no-empty`，lint 归零 error）。
- 验证：shared/sdk/core 重建、ui tsc/eslint/build、全量 **212 测试**全绿；exec/reveal/usage/providers 真机 curl 往返（含测试 provider 加删清理）+ Playwright 视觉核对（工具卡统一、用户气泡、进度环、放大铺窗、来源点击预览）。

## 2026-06-21（续）— 统一右侧「工作台坞」+ 网页内联预览 + 交互式终端

把对话区与工作区右侧三套各自为政的抽屉（工件面板 / 网页预览 / 工作区 Diff·Files·Terminal）合并为**一个共享的 `SideDock`**，并按使用反馈补三项能力。后端仅新增 exec/reveal 两类端点，其余纯前端。

- **网页内联预览（修 bug）**：Tauri webview 里点 web_search 来源 / 消息内 markdown 链接的 `target=_blank` 会把整个 app 导航走且回不来。改为 `MessageStream` 统一拦截 → 右侧预览（`onOpenUrl`），来源 chip 由 `<a>` 改 `<button>`、markdown 链接自定义 `a` 渲染；`referrerPolicy=no-referrer` + sandbox iframe，禁内嵌站点退化为「复制链接」。
- **统一 `components/SideDock`**：一条 tab strip = **改动（git，按需）/ 文件 / 终端 / 预览**，对话区与工作区共用。合并点：工件列表 + 工作区文件树 → 同一「文件」浏览器（内联预览，HTML 源码/渲染切换）；独立 WebPreview + HTML 工件 → 统一「预览」；一套滑入外壳 + 一个 z-index（消除原预览 z=30 盖住工件 z=20 的叠加冲突）。点链接自动切「预览」tab。删除 `ArtifactsPanel`、独立 `WebPreview.tsx`、`WorkspacePanel` 及全部子组件 + 死 CSS（`.ws-review/.chat-files/.web-preview/.wp-tabs`）。对话线程非 git 项目 → 对话坞不显示「改动」。
- **预览放大到窗口**：坞头部 ⤢/⤡ 切换 `position:fixed inset:0` 铺满整窗（盖住轨道/会话列表/标题栏）。
- **交互式终端**：终端 tab 改 REPL —— 顶部展示 **AI 最近 run_command**（带「AI」标签），底部 `$` 输入框回车在当前工作目录执行，历史带退出码 / 截断提示。新增 `POST /workspace/:id/exec`、`/chat/:threadId/exec`（`spawn(shell)`，cwd 限定工作区/会话目录，120s 超时 + 200k 输出上限，合并 stdout/stderr）；SDK `wsExec/chatExec` + `ExecResult`。与 agent run_command 同为任意 shell，靠 daemon token 把守（0.0.0.0 仍强制 api-key）。
- **打开目录**：文件 tab 头部 📂 → 系统文件管理器打开该目录。新增 `POST /workspace/:id/reveal`、`/chat/:threadId/reveal`（复用 `/skills/open` 的 `open`/`explorer`/`xdg-open` 模式）；SDK `wsReveal/chatReveal`。走 daemon 端点而非 Tauri 插件：不改 Rust capability，同时服务对话/工作区两种 cwd。
- 顺手去掉标题栏装饰性假交通灯点（macOS 已有原生窗口按钮）。
- 验证：shared/sdk/core 重建，ui tsc/eslint/build 全绿，core typecheck 通过；exec/reveal 真机 curl（退出码/cwd/截断/打开 Finder）+ Playwright（统一坞四 tab、来源点击自动切预览且 iframe 加载、终端 AI 命令 + 输入框、放大铺满窗口）。

## 2026-06-21 — 前端全重构为 Agent Desk 设计语言（冷灰三栏代理工作台）

经 claude_design MCP 从 claude.ai/design 导入 **Agent Desk** 设计（项目「桌面代理设计风格研究」），把前端从「Claude 暖米白侧栏 + 单页」整体重构为冷灰 + 靛蓝的三栏 IDE 式工作台。分阶段落地，每阶段 typecheck/build/eslint 绿 + 真机 Playwright 验证、独立提交：

- **P0 token + 字体**：`@fontsource/ibm-plex-sans + jetbrains-mono`（离线内置）；`styles.css` token 全量重写为 Agent Desk（`@theme` 浅色 + `[data-theme=dark]` + `[data-accent=iris|teal|amber]` + `[data-density]`），主题机制从 `.dark` class 改为 `<html>` 的 data-* 属性；prefs/index.html/设置页外观（明暗 + 三色 + 密度）。
- **P1 工作台 shell**：重写 `App.tsx` → 标题栏（交通灯 + accent 三点 + 密度/主题/设置）+ 图标轨道（对话/工作区/收件箱 + 记忆/设置 + 账户）+ 会话列表 + 主区 + 可拖拽 resizer（持久化）；次级页（模型/知识库/Skills/MCP/记忆/设置）收进 Settings/Memory 浮层。新增 `components/{Titlebar,IconRail,SessionList,SettingsOverlay,MemoryOverlay}`。
- **设置浮层面板**：scoped CSS 把复用页面收敛成 Agent Desk 设置观感（扁平区块 + 标题/描述 + 列表项卡片）；**Skills/MCP 改行卡片 + 真实开关**（Skills→`excludeSkills` 经 pi `skillsOverride` 过滤；MCP→`enabled`）。
- **P2 对话区**：抽 `components/MessageStream`（聊天与工作区共用）——头像 + 名 + 时间线（思考 / 工具卡 READ·EDIT-diff·RUN-terminal / 文本）+ thinking 三点；**用户消息右对齐**。
- **P3 会话列表分组 + 工作区面板**：工作区按项目分组→其会话（CWD 角标），会话选择上移到 App（Workspace 改受控 threadId）；工作区面板扩成 **Diff / Files(wsList+wsRead) / Terminal(最近 run_command)** 三标签。
- 后端仅一处增量：`/agent/run` + SessionHost 加 `excludeSkills`（pi `skillsOverride` 按名过滤），其余纯前端。全量 **212 测试**绿。

## 2026-06-18 — 工作区 v2（提交历史 + push/pull）+ 次级页视觉精修

### 工作区 v2：提交历史 + push/pull
- 盘点发现「多会话回放」此前已实现（会话下拉/新建/切换/删除/按线程历史）。本次补两项：
- **GitService** 新增 `log`（`git log` 用 `\x1f/\x1e` 分隔解析，封顶 200，新仓库空）、`remoteInfo`（远程/上游 + ahead/behind via `rev-list --left-right --count @{upstream}...HEAD`）、`push`/`pull`（新 `runNet`：`GIT_TERMINAL_PROMPT=0` + `ssh -oBatchMode=yes` + 60s 超时，杜绝凭证交互挂起；无上游 push 回退 `-u origin <branch>`，无 origin 优雅报错；pull 用 `--ff-only`）。
- 端点 `GET /git/log|/git/remote` + `POST /git/push|/git/pull`；SDK `gitLog/gitRemote/gitPush/gitPull` + `GitCommit`/`GitRemoteInfo` 类型。
- UI 审查面板：头部下方**远程条**（上游 + `↑ahead ↓behind` + 拉取/推送按钮，结果行内反馈）+ 底部**「提交历史」折叠区**（懒加载最近 30 条，提交/拉取后刷新）。
- **接受/拒绝单改动（per-hunk）**：`GitService.hunkOp(path, hunkIndex, op)` 从该文件 diff 抽第 N 个 hunk 构造最小补丁 → `git apply`（stage=`--cached` / unstage=`--cached --reverse` / discard=`--reverse`，`--recount` 容错）；端点 `POST /git/hunk`、SDK `gitHunk`；diff 视图每个 @@ 块悬停显示「暂存块 / 丢弃块」（未暂存）或「取消暂存块」（已暂存），hunk 索引与后端按同一份 diff 对齐；untracked 仍按整文件。
- 验证：GitService 单测 +5（log/remote/push/部分暂存/丢弃块）、git 测试 14 全过、全量 **212 测试**绿；真机 API e2e（log / remote / push 文案 / per-hunk 部分暂存：staged 含块 0、unstaged 含块 1、文件同时 staged&unstaged）。
- v2 仅剩内嵌可编辑编辑器（按需，不引入）。

### 次级页视觉精修（知识库 / Skills / MCP / 记忆 / 设置）
- section 头部图标**去彩虹**：原 `.ico.blue/.green/.violet` 三色统一为中性瓷砖 + 珊瑚字（页头仍珊瑚瓷砖，形成层级），贴合单 accent 暖色主题。
- 列表卡片（mcp-row/kb-doc/mem-item/skill-card）统一 12px 圆角 + 悬停反馈；pills（mem-scope/kb-coll）全圆角。
- MCP / 记忆的纯文本空态换成图文空态（与模型/知识库一致）。

## 2026-06-17（续）— pi SessionManager 跨重启上下文 resume

把 pi 会话改为**按 threadId 落盘 + resume**：daemon 重启 / 会话重建后，模型仍带上重启前的上下文（含 compaction）。

- 先做了方案评估：核实 pi `SessionManager` 是**文件式追加写树状日志**，无 FTS5 检索 / 渠道映射 / 项目元数据。结论——"把真相源切到 SessionManager"是**反效果**（会丢这些能力 + 大改 UI/SDK 且无净收益）；真实诉求（跨重启上下文）可单独拿到。
- 实现（`SessionHost`）：`sessionsDir = <dataDir>/pi-agent/sessions`；`sessionManagerFor(threadId, cwd)` —— 文件存在则 `SessionManager.open()` 续接，否则 `create()` 后 `setSessionFile()` 定向到 `<threadId>.jsonl`（create 惰性写，不产生孤儿文件）；注入 `createAgentSession({ sessionManager })`。重建（换模型/作用域）走 open 同一文件 → 上下文也不丢。`dispose(threadId)` 删 thread 时一并删该 session 文件（已有逻辑天然适配）。
- **ConversationRepo 零改动**，仍是 UI / 全文检索 / 渠道映射 / 项目元数据真相源（两者并存，非替换）。
- 验证：typecheck 19/19、199 测试全绿；**跨重启真机 e2e**（隔离数据目录 + 真实 Qwen3-4B）：daemon#1 记代号 ALPHA-7 → SIGKILL 硬重启 → daemon#2 同目录续写（会话文件追加增长、旧轮次仍在）→ **模型答出 ALPHA-7**，证明上下文真正跨重启恢复。

## 2026-06-17 — UI 重设计（Claude 设计语言）+ 思考过程持久化 + 模型页本地/云端分页

### UI 重设计：Tailwind v4 token 切到 Claude 桌面端观感
- 设计语言从 TOKENICODE 黑灰切到 **Claude 暖米白 + 黏土珊瑚**（`@theme` + `.dark`），保留明暗双主题、**移除三色主题切换**（单 accent）；空态改**衬线问候**（系统衬线栈）+ 起手式 pill；用户气泡改暖中性块（新增 `--color-text-user-msg`）。
- 侧栏重构：顶部**分段控件「对话 | 工作区」** + 上下文动作行（新对话 / 新建工作区）+ 按模式切换的 Recents（仿 Claude 桌面端），次级页仍在 profile 弹菜单。
- 图标统一：全站 lucide 笔画细化到 `1.75`（CSS 覆盖 SVG 属性）贴合柔和主题；`✕`/`×`/`⚠️` 文本符号统一换成 lucide `X` / `TriangleAlert`。
- 对话：**思考 / 联网默认开启**。

### 模型页：本地 / 云端 API 分页
- 顶部分段「本地模型 | 云端 API」。本地 = 原 HF 搜索/下载 + 加载网格；**云端 = 从设置页迁入的 provider 管理并升级**：常见端点预设快填（OpenAI/OpenRouter/DeepSeek/硅基流动）+ 卡片列表 + 删除（接上一直未用的 `removeProvider`）；仅在云端 tab 按需拉取 `/providers`。
- 设置页随之精简：去掉云端 Provider 段与三色主题，保留 外观 / Agent 循环 / 本地网络。

### 思考过程（reasoning）持久化与回放
- 之前 reasoning 只在流式时展示、不落库，切换/重载会话即消失。现以新增的 **`reasoning` ContentPart** 完整保真持久化：`ToolTurnRecorder` 按序把 reasoning 交织进每轮 parts 并经 `trailingReasoning()` 暴露收尾轮思考；`app.ts` final 消息带 reasoning part（优先 reasoning 事件，兜底剥离内联 `<think>`）；`storedToUiMsgs` 按 parts 顺序重建思考/文本块。`messageText` 仍只取 text → reasoning **不进历史回喂/会话搜索/模型上下文**；各模型侧转换器显式剔除（openai-messages 转换前 filter、pi-adapt/ew-extensions if/else 不收录）。
- 真机 e2e（Qwen3-4B 隔离数据目录）验证：开思考问答后回读会话，reasoning part 正确持久化（逐轮 + 收尾两条路径）。

### code-review 修复
- #1：`toOpenAIContent` 转换前过滤 reasoning（杜绝 latent 的 `[reasoning]` 占位发给模型）+ 修正 `message.ts` 注释。#2：app.ts reasoning 兜底先各自 trim 再 `||`。#3：recorder 过滤对 reasoning 也 trim，不存空白思考块。#4：模型页 `/providers` 改按 tab 懒加载。
- 结果：**199 测试全绿**（新增 reasoning 交织/trailing、openai-messages 剔除 reasoning 回归），typecheck 19/19，UI build 通过，改动文件 eslint 0；多轮 Playwright（明暗 / 分段 / 模型双 tab / 设置）+ 桌面壳实跑验证。

## 2026-06-16 — 对话工件面板 + 记忆机制重构（作用域 / 渐进式披露 / 批量抽取 / sqlite-vec）

### 对话模式右侧「工件」面板
- 对话 cwd 改为**每会话目录** `~/.easywork/workspace/chats/<threadId>`（会话间隔离，删对话时一并清除）。
- 新增 `GET /chat/:threadId/files`（列文件，缺目录返回空）+ `/chat/:threadId/file`（只读预览），经 `resolveWorkspacePath` 沙箱，挡 `../` 与绝对路径。
- 前端 `Chat.tsx` 右侧 `ArtifactsPanel`：文件列表 + 类型图标 / 大小，点击预览（文本 / 代码内联、HTML 可切「预览(iframe)/源码」）；文件类工具完成即刷新、首次出现工件自动展开；标题栏「工件」开关带计数。

### 向量召回完全改用 sqlite-vec（移除 JS 余弦 brute-force）
- 抽出共享 `SqliteVecIndex`（`@ew/memory`）：封装 `vec0` 表的 load/ensureTable/set/knn（`distance_metric=cosine`，`node:sqlite` `loadExtension`，rowid 须 `BigInt`）。**记忆与知识库 RAG 共用**（KB 用 `kb_vec` 表 + 词法 RRF）。
- `sqlite-vec` 升为 `@ew/core` 正式依赖（随包带各平台预编译二进制）；`embedding` blob 仍存源表作 durable 重建源，vec 表是查询索引、随写/改/删/reindex 同步；扩展无二进制时降级纯词法。`knn` 以全表 count 作 k（分区安全，多集合不漏）。

### 记忆机制重构（按用户四项要求）
- **作用域化**：每条记忆带 `scope`。**全局池**（`global`=对话记忆，所有对话共享，层 user-profile/agent-memory/skills）+ **每工作区私有池**（`ws:<projectId>`，互相隔离、独立于全局，层 conventions/decisions/pitfalls——盯约定/变动/坑，记 why 不记 diff）。工作区只读叠加全局 user-profile（共享身份），写只进本池（`visibleScopes`）。删对话按 `sessionId` 清抽取事实；删工作区按 `deleteByScope` 清整池（HTTP 端点拒清全局，护栏）。全局池保留 markdown 镜像可手改回灌，工作区池 DB-only。
- **注入：纯渐进式披露（借鉴 Skill）**：`before_agent_start` 把「记忆清单」（仅标题，`buildMemoryManifest`）拼进系统提示词；全文经新增 `recall_memory` 工具按需语义检索取。`manage_memory` 按 scope 参数化。**移除冻结快照全量灌入 + 每轮自动召回**。
- **抽取：模型抽取 + 批量（非每轮）**：调度由 **`ExtractionScheduler`（SessionHost 拥有，非 pi 扩展闭包）** 负责——增量缓冲新轮次（列表变短=压缩→重新基线，长突发不漏早期轮次），达 `maxTurns(24)` 立即分块抽、否则 ~90s 空闲去抖。提示词按 scope 切换；`turnsForExtraction` 把写文件/命令的工具调用压成摘要喂抽取器。`core.stop()` 停模型前 `flushAllExtraction()`（graceful 退出不丢尾部），删会话则 discard 不抽。
- **记忆页 UI**：顶部作用域选择器（全局 + 各工作区）；层标签 / 浏览 / 编辑 / 删除 / 召回测试均按作用域；工作区可「清空本工作区记忆」（确认弹窗）。

### 两轮 code-review 修复
- M1：抽取窗口截尾改增量缓冲（长突发不漏）。L1：清空端点拒清全局。L2：工作区清单里全局层标「全局·」。L3：`recall_memory` minScore 0→0.1 去噪。
- M2：移除压缩触发抽取（缓冲独立于 pi 上下文，不与主运行并发打模型）。L4：删对话清其工件目录。L5：抽取含工具摘要。L6：抽取调度移入宿主，停模型前 flush、删会话 discard（修「抽取正被删除的对话」隐患）；SIGKILL 仍丢（可接受）。
- 结果：**196 测试全绿**（新增工件面板端点、作用域隔离/deleteByScope、`ExtractionScheduler`/`turnsForExtraction`、KB sqlite-vec 等），typecheck 19/19；多轮真机 e2e（HTTP 作用域读写召回互不串、工件面板 Playwright、L4/graceful 关停）。

## 2026-06-15（续）— 代码 review 修复（pi 迁移 + /v1 + 本地暴露）

三路并行 review 后修复确认问题：
- **H1 并发串流**：`SessionHost.run` 按 threadId **串行化**（promise 链）——同一会话同一时刻只跑一轮，杜绝 pi 全局 subscribe 跨请求串流 + 共享 runtime 审批错配（IM 连发/双击/重连可触发）。
- **H2 绑定 host 三连**：`LocalServerManager` 加 mutex（串行化 load/unload/applyNet/stopAll）；`applyNet` 逐个 try/catch **重载失败不清空全部**；`/settings/local-net` 成功后 `sessionHost.invalidateAll()` **重建会话避免指向旧端口**。
- **H3 云端出错被吞/伪装**：在两个协议翻译器加 `error` 处理——OpenAI 发 error 帧、Anthropic 发 `event: error` 且 **不再伪装成 `end_turn`**（修本地引擎与云端两条路径）。
- **0.0.0.0 强制 api-key**：`LlamaServerEngine --api-key`；`LocalServerManager.apiKey`（透传子进程）；`/settings/local-net` 绑 0.0.0.0 **必须**非空 key（否则 400），内部回环调用（pi/proxy/fact-extractor）一并带 Bearer；UI 加 api-key 输入 + 生成按钮 + 告警示范请求头。引擎自连接恒走 127.0.0.1 回环。
- **M1 SSE 写已关闭 socket**：proxy/`/agent/run`/云端分支加 `raw.on("error")` + `writableEnded/destroyed` 守卫 + finally try/catch。
- **M2 cloudStream 抛错**：try/catch 包裹 → 回退引擎而非 500。
- **M3 召回缓存陈旧**：召回缓存挂到 `RunRuntime`，每轮 `run()` 重置。
- **M4 软链接越界**：`escapesCwd` 经 `realpath` 解析（取最深已存在祖先）再比对，挡住"工作区内软链接指向外部"；并补 old_path/new_path 字段。
- 结果：**176 测试全绿**（新增 symlink 越界、云端 error 终止、api-key 透传、no-strand 重载等），typecheck 19/19，改动源码 eslint 0，真机 e2e 通过无越界产物。

## 2026-06-15 — 内核换为 pi-coding-agent（托管 AgentSession，硬切）

把 EasyWork 的 agent 内核从自研 loop **硬切**为托管 `@earendil-works/pi-coding-agent` 的 `createAgentSession`（无头嵌入），EasyWork 退化为宿主/集成层。分 R0–R5 推进，每阶段真机 e2e（本地 llama-server）验证：

- **R0**：`scripts/spike-session.mjs` 证明 AgentSession 可无头嵌入 + 本地模型驱动 + 自带工具 + 自动 compaction。
- **R1**：`agent/session-host.ts` — `SessionHost` 封装 createAgentSession，按 threadId 复用会话；`mapSessionEvent` 把 pi `AgentSessionEvent` 映射为我们的 SSE `AgentEvent`（唯一边界翻译）。
- **R2**：单一落盘共享 `AuthStorage`/`ModelRegistry`；`syncCloudProviders` 把云端 provider（key/headers/baseUrl）对账进 pi；本地走 `baseUrlFor`。
- **R3**：`agent/ew-extensions.ts` — 记忆经 pi `context`（召回注入）+ `agent_end`（事实抽取）扩展；`toPiTool` 把我们的 `Tool` 桥成 pi customTool；`manage_memory`/`session_search`/`search_knowledge_base`/MCP/内置工具均以 customTools 注入。
- **R4**：pi `tool_call` 钩子映射审批 4 档（read-only/approve-each/auto-edits/full-auto）经 `ApprovalGate`（沿用 approval-request SSE）；工作区/聊天模式工具收窄。
- **R5（硬切清理）**：`/agent/run` 仅走 pi（移除 `EW_KERNEL` 过渡门 + legacy 分支）；删除自研内核 `agent/{loop,healing,turn-recorder,tool-registry,workspace-approval,approval}.ts` 及其测试；内置工具桥成 customTools 保留能力。**保留**（仍在用）：`EngineRegistry`/`LocalServerManager`/`ProviderManager`（撑 `/v1`·`/chat/stream`·fact-extractor）、`approval-sse`、`memory/session/rag` 工具、`@ew/tools`。
  - 结果：**148 测试全绿**（删 ~36 legacy 测试），typecheck 19/19，改动文件 eslint 0。

### R5b — 收尾（abort / MCP 刷新 / 工具历史 / 工作区限定）

- **工具历史持久化**：恢复 `ToolTurnRecorder`，把 pi 事件流里的 assistant tool_calls + tool results 重建并写入 `ConversationRepo` → 刷新后历史完整（修复 R5 只存 user+final 的回退）。
- **abort 透传**：`SessionHost.run` 接 `signal`，SSE 断开 → `AgentSession.abort()` 中止 pi 当前轮。
- **MCP 动态刷新**：`/mcp/servers` 增删后 `sessionHost.invalidateAll()`，下次 run 重建会话以纳入新 customTools。
- **工作区路径限定（安全）**：发现 pi 自带 fs 工具**不做路径沙箱**（`write ../escape.txt` 真会越界写到父目录）。在 `permissionExtensionFactory` 加 `escapesCwd` 硬边界：read/edit/write/ls/grep/find 的 `path/file_path` 越界一律拒（所有档位，含 full-auto）；bash 为任意 shell 仍由审批把守。`workspace-confinement.test` 记录 pi 原始行为，`permission.test` 锁定我们的拦截。
- **`/chat/stream`**：已删除（无消费者，应用内走 /agent/run，裸对话走 /v1）。
- **`/v1` 网关重构（两步）**：
  - Step1 **本地透传**：`/v1/chat/completions`·`/v1/messages` 命中已加载本地模型时反向代理到其 llama-server（原生支持 OpenAI + Anthropic + tool_use，带 --jinja），不经我们的翻译层。
  - Step2 **云端经 pi-ai**：云端请求 → `SessionHost.streamCloud`（流式 `streamSimple`）/ `completeCloud`（非流式 `completeSimple`），复用 R2 的 ModelRegistry/AuthStorage（含 OAuth/Anthropic 原生）→ `pi-adapt` 把 pi 事件/消息映射回 `ChatStreamEvent`/`ChatResponse`，**复用既有** `streamEventToOpenAIChunks`/`AnthropicStreamTranslator`/`chatResponseToOpenAI`/`chatResponseToAnthropic`。pi 出错回退引擎。
  - `EngineRegistry`/`LlamaServerEngine` 仍保留：撑本地进程管理、`/v1` 非流式回退、fact-extractor、embedding。
  - 更正：早前说"llama-server 不支持 Anthropic"有误——llama.cpp 已原生支持 `/v1/messages`（PR #17570），故本地透传可直接复用。
  - **本地端口暴露**：`LocalServerManager` 加可配置绑定 host（`setBindHost`/`getBindHost`/`endpoints`），默认 `127.0.0.1` 仅本机、可选 `0.0.0.0` 局域网；切换时重载已加载模型立即生效，持久化到 settings。内部 `baseUrlFor` 恒走 `127.0.0.1` 回环（即使绑 0.0.0.0）。`/models` + `GET/POST /settings/local-net` 暴露端点与 LAN IP；UI「设置 → 本地网络」可切换并展示各模型直连 URL（0.0.0.0 带未鉴权告警）。
- **未做（明确）**：持久化仍以 `ConversationRepo` 为真相源（未切 pi `SessionManager` 为真相源——那是涉及 UI/SDK 的独立大改，无用户可见收益）。
- 结果：**156 测试全绿**（+8），typecheck 19/19，改动文件 eslint 0，真机 e2e 通过且无越界产物。

## 阶段总览

- [x] **阶段 0 — 地基**：CLAUDE.md、monorepo 骨架、`@ew/shared`、`@ew/engine-worker`、`@ew/core`+`@ew/sdk`+`@ew/daemon` 端到端贯通 ✅
- [x] **阶段 A — 模型运行**：EngineRegistry、local-llamacpp / openai-compatible provider、ModelManager（HF 搜索/下载/扫描）、`/v1` 端点 ✅
- [x] **阶段 B — Agent 工具**：自愈解析器、ToolRegistry/ApprovalGate、agent loop controller、MCP client、Skills runtime ✅
- [x] **阶段 C — IM + 记忆**：MemoryProvider（本地分层 markdown + 向量/词法召回）+ Mem0 骨架、ConversationRepo、ChannelConnector + Host + Telegram ✅（Discord/WeCom/Feishu 待补）
- [x] **阶段 D — 桌面 + UI**：Electron supervisor、React UI（Chat/模型/设置）、electron-builder 配置 ✅（GUI 未在本环境可视化验证；连接器 Discord/WeCom/Feishu 待补）

## 时间线

### 2026-06-13
- 完成调研（Unsloth Studio 架构、node-llama-cpp、Electron vs Tauri、Hermes 记忆）。
- 确认需求与关键决策（见 CLAUDE.md / plan）。
- 创建 CLAUDE.md 与本进展文档。
- **完成阶段 0 地基**：
  - monorepo 骨架（npm workspaces + Turborepo + tsup + vitest + eslint/prettier）。
  - `@ew/shared` 契约层（message/tool/provider/model/skill/memory/mcp/im/conversation/events 的 zod schema + 类型 + `canonicalToolCallKey`/`stableStringify`/`mcpToolName` 等工具）。
  - `@ew/engine-worker`：`LocalLlamaEngine` 实现 `InferenceEngine`（node-llama-cpp **动态加载**，load/unload/chatStream/embed，per-handle 串行化，AsyncQueue 回调→async iterable 桥接）。
  - `@ew/core`：Fastify daemon（bearer 鉴权、`/health`、`/models`、`/models/load`、`/models/unload`、`/chat/stream` SSE）+ `EngineRegistry` + 数据目录解析。
  - `@ew/sdk`：类型化客户端（health/listModels/loadModel/chatStream SSE 解析）。
  - `@ew/daemon`：CLI `easywork serve`（写 daemon.json，优雅关闭）。
  - **验证**：`turbo build` + `turbo typecheck` 全绿；3 个端到端契约测试通过（SDK→core→fake engine 流式、鉴权 401、未加载模型 404）；真实 daemon 进程 `curl /health`、鉴权、shutdown 全部 OK。
  - 已知后续：实际加载真实 GGUF 的烟测需下载模型（阶段 A 的 ModelManager 落地后做）；agent loop 的自愈解析与工具调用归一在阶段 B。
- **完成阶段 A 模型运行**：
  - `@ew/providers`：`OpenAICompatibleEngine` 实现 `InferenceEngine`（ChatRequest→OpenAI body，上游 SSE delta→ChatStreamEvent，**含原生 tool_calls 增量累积**，非流式 chat() + embeddings）。
  - `@ew/core/models`：`ModelManager` = HF 搜索（`/api/models`）+ `listVariants`（`tree` API + **纯函数 `groupVariants` 分片归组/quant 提取/mmproj 识别**）+ `downloadVariant`（Range 续传 + 多分片 + 进度事件）+ `scanInventory`（最小 **GGUF 头解析** `parseGGUFBuffer`：magic/version/arch/context_length，截断容错）。
  - `@ew/core/providers`：`ProviderManager` 把云端 provider 注册为引擎并路由模型。
  - `@ew/core/openai-compat`：`/v1/chat/completions`(+stream)、`/v1/models`、`/v1/embeddings`，复用同一 `EngineRegistry`（外部工具如 Claude Code 可指向 `/v1`）。入站/出站双向转换（含流式 tool_calls chunk）。
  - daemon 路由：`/models/search` `/models/variants` `/models/local` `/models/download`(SSE) `/providers`(GET/POST/DELETE)。SDK 补齐全部方法 + 复用 SSE 解析。
  - **验证**：build/typecheck/lint 全绿；14 个测试通过（分片归组、enumerateShards、GGUF 解析含截断容错、OpenAI 引擎流式+tool_calls+非流式、`/v1` 经云端 provider 流式+非流式+404、原 contract 3 项）。真实进程烟测：addProvider→`/v1/models` ✓、**live HF 搜索返回真实 GGUF 仓库** ✓、**live `/models/variants` 解析 26 个变体（quant/size/分片正确，按大小排序）** ✓。
  - 已知后续：真实 GGUF 本地推理烟测（需下载 ~200MB+ 模型，未在 CI 跑）；密钥目前内存态，阶段 C 接 keychain/SQLite 持久化。

### 2026-06-13（续）— 真实模型实测
- **本地文本推理端到端打通**（`scripts/smoke-local.mjs`）：经 `ModelManager` 从 HF 下载 `unsloth/Qwen3-0.6B-GGUF` Q4_K_M（397MB，带实时进度）→ GGUF 头解析正确（arch=qwen3, ctx=40960）→ `LocalLlamaEngine` 在 **Metal** 上 493ms 加载 → 真实流式推理 0.6s 给出连贯中文回答。
- **重要发现：node-llama-cpp 3.18.1 不支持多模态/视觉**（无 mmproj/image 输入 API）。多模态本地推理改由后续 `LlamaServerEngine`（llama.cpp server `--mmproj` 子进程）实现 → 见任务 #10。多模态数据通路（image→ContentPart→image_url）已在 `OpenAICompatibleEngine` 就绪。
- **修复下载健壮性 bug**：首次实测时一次传输被提前关闭（undici 把早断流当成正常 EOF），导致 540KB 残缺文件被当成完成。已加 **content-length + 单分片已知大小校验 + 短读自动重试（Range 续传）+ .part 保留**；配 2 个回归测试。

### 2026-06-13（续）— 阶段 B Agent 工具
- **自愈 tool-call 解析器**（`core/agent/healing.ts`）：逐行移植 `tool_healing.py`，JSON 大括号平衡+字符串转义、XML function/parameter 闭合标签可选、name 含 `-`；15 个精确性测试。
- **ToolRegistry + ApprovalGate**：`shared` 增 `Tool/ToolProvider/ToolExecContext/ApprovalGate/needsApproval`；`@ew/tools` `defineTool`（zod→JSON Schema+校验）+ 内置 `get_time`/`calculator`/`http_get`（http_get first-use 审批）。`AutoApproveGate` 默认放行（local-first）。
- **Agent loop**（`core/agent/loop.ts`）：model→tool→model 循环；非原生引擎尾缓冲剥离 markup 流式输出 + 流末解析；`canonicalToolCallKey` 去重；max-iter 兜底；tool 错误作为 tool 消息喂回；审批门。
- **MCP client**（`@ew/mcp`）：`@modelcontextprotocol/sdk` stdio+streamableHTTP（动态导入，connect 可注入便于测试）；`mcp__<srv>__<tool>` 命名空间；失败 cooloff(60s/OAuth 300s)+工具缓存；作为 ToolProvider。
- **Skills runtime**（`@ew/skills`）：扫描 SKILL.md（极简 frontmatter 解析）→ 系统提示目录（第一层披露）+ `open_skill` 工具懒加载正文（第二层）；每次 /agent/run 重扫即热重载。
- **daemon 接线**：`/agent/run`(SSE 发 AgentEvent)、`/mcp/servers`(GET/POST/DELETE)、`/mcp/probe`、`/skills`；内置工具 + Skills/MCP 动态 provider 注入 ToolRegistry。SDK 补 `runAgent`/`listSkills`/`listMcpServers`/`upsertMcpServer`。
- **验证**：45 测试全绿（解析器精确性、agent loop 5 例含去重/原生 tool_call/审批拒绝/未知工具、Skills 发现+披露、MCP 命名空间+content 拍平+cooloff、**/agent/run 端到端：云端原生 tool_call→真实 calculator 执行 6×7=42→喂回→收尾**）；build/typecheck(17)/lint(0 err) 全绿。

### 2026-06-13（续）— 阶段 C IM + 记忆
- **重大技术调整：用 `node:sqlite`（内置 DatabaseSync）替代 better-sqlite3**。better-sqlite3 11.x 用了 Node 26 已移除的 V8 API（GetPrototype/GetIsolate/PropertyCallbackInfo::This），源码编译失败 —— 正是计划里 #1 的原生 ABI 风险。`node:sqlite` 零原生编译、Node 26 原生可用。Vite/Vitest 不识别该新内置 → 用 `createRequire` 运行时加载（`import type * as` 取类型）绕过打包器静态解析。
- **`@ew/memory`**：`LocalMemoryProvider` —— 分层 markdown 镜像（user-profile/agent-memory/skills/sessions）+ SQLite 索引 + **向量语义召回（注入 embedder）/ 词法降级召回**（topK/minScore 防稀释）；`observe` 启发式写会话摘要；`Mem0MemoryProvider` 适配器骨架（证明可插拔）。
- **`ConversationRepo`（SQLite）**：projects/threads/messages(JSON parts)/channel_sessions；`resolveThreadForChannel(kind,channelUserId)` —— 跨渠道同一大脑映射。
- **`@ew/im-connectors`**：早期落地 `ChannelConnector` 兼容接口 + `ConnectorHost`（inbound→resolveThread→取历史→runAgent→批量回复→持久化）+ **Telegram 连接器**（Bot API 纯 HTTP 长轮询，注入 fetch 可测）；后续已升级为 Channel Gateway（见 2026-06-30）。
- **记忆集成进 agent loop**：生成前 `recall` 注入系统上下文（发 memory-recall 事件）+ 生成后 `observe`。
- **daemon 接线**：`/agent/run` 带记忆、`/threads`、`/threads/:id/messages`、`/memory`(GET/POST)、`/mcp/servers`、`/skills`。SDK 补 `runAgent`/`listThreads`/记忆/MCP 方法。
- **验证**：57 测试全绿（记忆词法+向量召回/observe/edit/delete/markdown 镜像、ConversationRepo 映射+seq、ConnectorHost 路由+持久化、Telegram pollOnce+offset+reply、agent 记忆集成）；build(11)/typecheck(20)/lint(0) 全绿；真实 daemon 烟测 /memory 写读、/mcp/servers、/threads 全部 OK。
- 测试基础设施：vitest `fileParallelism:false`（共享 SQLite 文件避免锁竞争）+ `EW_DATA_DIR` 指向 tmp。

### 2026-06-13（续）— 多模态 sidecar（任务 #10）✅
- **`LlamaServerEngine`（@ew/providers）**：子进程跑 llama.cpp `llama-server -m … --mmproj … --jinja`（OpenAI 兼容），health 轮询就绪后把 chat/chatStream/embed 委托给指向其 `/v1` 的内部 `OpenAICompatibleEngine`。`spawn`/`fetch` 可注入便于测试。
- **真实多模态实测通过**（`scripts/smoke-vision.mjs`）：`brew install llama.cpp`(llama-server 9610) → 从 HF 下载 SmolVLM-256M Q8_0(175MB)+mmproj(104MB) → Metal 启动 → 发送脚本生成的红色 PNG 提问颜色 → **模型答 "Red"**。完整通路：image→ContentPart→image_url→llama-server→SmolVLM。
- 单测：注入 spawn/fetch 验证 `--mmproj`/`--jinja` 参数、health 轮询、chatStream 委托、stop 杀进程、未启动报错。
- 现在共 **59 测试全绿**，build(11)/typecheck(20)/lint(0)。多模态本地推理已可用（需机器有 llama-server 二进制）。

### 2026-06-13（续）— 阶段 D 桌面 + UI
- **`apps/desktop`（Electron）**：`DaemonSupervisor`（spawn daemon、readline 解析 stdout 首行 {baseUrl,token,pid}、health 就绪、崩溃 autoRestart、stop；注入 spawn 可测）；Electron main（用 Electron 自带 Node + `ELECTRON_RUN_AS_NODE` 跑 daemon、`app.getPath('userData')` 作 EW_DATA_DIR、创建窗口、ipc `ew:config` 同步下发连接信息）；preload（contextBridge 暴露 `window.ewConfig`）。CJS 构建（main.cjs/preload.cjs）。
- **`apps/ui`（React + Vite）**：从 `window.ewConfig`（或浏览器 `?baseUrl&token`）取连接信息，经 `@ew/sdk` 走 HTTP/SSE。三页：**Chat**（runAgent 流式 + 工具事件内联展示 + 模型选择）、**Models**（HF 搜索→变体→下载进度→加载 + 本地模型列表）、**Settings**（云端 provider / MCP stdio / 记忆查看）。深色主题 CSS。
- **打包**：`apps/desktop/electron-builder.yml`（mac dmg/zip、win nsis、linux AppImage/deb；node-llama-cpp asarUnpack；ui dist 作 extraResources）。
- **根脚本**：`dev:daemon`/`dev:ui`/`dev:desktop`。CLAUDE.md 补全运行说明。
- **验证**：build(13)/typecheck(23)/lint(0) 全绿；**61 测试**含 **DaemonSupervisor 无头集成测试（spawn 真实 daemon→解析连接信息→/health 可达）**。
- 局限：**GUI 未在本无显示环境可视化验证**（vite build + 类型检查通过；数据层 SDK 已被集成测试覆盖）。需用户机器 `npm i electron`（本次安装用 `ELECTRON_SKIP_BINARY_DOWNLOAD=1` 跳过了二进制）后 `npm run dev:ui` + `npm run dev:desktop` 实跑。

### 2026-06-13（续）— 记忆向量召回（本地 CPU embedding，参考 Hermes）
- **调研 Hermes**：本地用 fastembed + **nomic-embed-text**(768 维)，混合召回（语义+BM25+图+时间，cross-encoder 重排）。本项目对齐：默认 nomic-embed-text、混合召回（语义 ⊕ 词法）。
- **去风险实测**：node-llama-cpp 在 **CPU** 上能 embed nomic GGUF —— 768 维，中文语义有效（sim 简洁↔精炼 0.891 ≫ 简洁↔天气 0.618）。
- **`EmbeddingService`（@ew/core）**：懒加载轻量 embedding GGUF（embedding-only，不建对话 context），探测维度；未就绪时 embed 抛错 → 记忆自动降级词法。
- **engine-worker**：`load({embeddingMode:true})` 跳过对话 context；`embed()` 用 `createEmbeddingContext`。
- **`@ew/memory`**：`recall` 升级为**混合召回**（`0.75*cosine + 0.25*lexical`，二者皆备时）；新增 `reindex({force})` 给历史条目补算向量。
- **daemon**：`GET/POST /memory/embedding`（启用/切换模型，默认 nomic Q4 自动下载 + reindex）、`GET /memory/recall?q=`（检视）。SDK 补 `enableEmbedding`/`embeddingStatus`/`recallMemory`。UI 设置页加「启用向量召回」按钮 + 状态。
- **真实端到端实测**（经 daemon）：写 3 条中文记忆 → 启用 nomic(Q4, CPU, 768 维, reindex 3) → 查询「关于我的宠物」**正确把"我养了一只叫 Mimi 的猫"排第一(0.555)**；启用前词法召回该查询无命中。
- **验证**：64 测试全绿（EmbeddingService、memory reindex+语义召回、混合召回）；build(13)/typecheck(23)/lint(0)。
- **启动自动启用**：embedding 模型选择持久化到 `<dataDir>/embedding.json`；daemon 启动后台自动检测（持久化设置或默认 nomic 路径已存在）→ 自动 setModel + reindex，无需每次手动点「启用」。实测重启后 ~数秒（CPU 加载 84MB）自动 ready=true。（nomic 的 tokenizer round-trip/eos 警告为良性，不影响 embedding。）

### 2026-06-13（续）— 架构调整：去 node-llama-cpp + 迁 Tauri（用户要求对齐 Unsloth）
- **本地推理全面改走 llama.cpp `llama-server`**（移除 node-llama-cpp）：
  - `LlamaServerEngine` 增 `embedding` 模式（`--embedding --pooling mean`）+ 默认 `-ngl 999`（Metal）。
  - 新增 `LocalServerManager`（core/engine）：每个加载的 GGUF 起一个 llama-server 子进程 + 注册到 EngineRegistry；文本/视觉统一。
  - `EmbeddingService` 重写为经 llama-server `--embedding` 运行（注入式 makeEngine，可测）。
  - 删除 `@ew/engine-worker` 包；core/daemon 去掉相关 dep/external；vitest alias 清理。
  - **实测**：daemon 启动自动经 llama-server 加载 nomic（768 维 ready）、写入+语义召回正确（Mimi 0.549）、确认 llama-server 子进程真实拉起、退出回收。65 测试全绿、build(11)/typecheck/lint(0)。
- **桌面外壳 Electron → Tauri 2**：
  - 删除 Electron main/preload/supervisor/electron-builder；新增 `src-tauri/`（Cargo.toml、tauri.conf.json、capabilities、build.rs、`src/lib.rs`+`main.rs`）。
  - Rust 外壳启动时 spawn `node <daemon> serve --port 0`（EW_DATA_DIR=~/.easywork，与 CLI/浏览器共用），读 stdout 首行 {baseUrl,token} 存入 state，经 `get_config` 命令 + `withGlobalTauri` 暴露给 webview；退出回收 daemon。
  - UI `client.ts` 增 Tauri 分支 `initRuntimeConfig()`（invoke get_config，带重试；内存态因 daemon 随机端口）。
  - **未编译验证**：本机无 Rust 工具链；标准 Tauri 2 写法，需 `npm i` + 装 Rust 后 `npm run dev:desktop`，按编译报错微调。`turbo build` 已排除 desktop（其 build=tauri，单独 `app:build`）。
- **UI 重构为 Unsloth Studio 信息架构（白蓝）✅**：对照 `unsloth/studio/frontend/public` 的真实截图独立重写（不抄代码）。改成**顶部栏 + 居中 segmented pill 导航 + 卡片**布局：logo+「本地」徽章（左）、聊天/模型/设置 pill（中，激活态蓝色渐变）、连接状态 chip + 弹层改连接（右）。off-white 表面、白卡片、**tinted-icon 分区头**（蓝/紫/绿）、pill 输入、蓝色主按钮、Space Grotesk 标题。**用 Playwright 实机截图逐页验证**（聊天空状态、模型 Hub 三栏、设置三卡片）通过。UI typecheck/build/lint 全绿。

### 2026-06-13（续）— UI 深度对齐 Unsloth（会话历史 + 思维链/工具卡 + 真机验证）
- **左侧会话历史栏**（Unsloth Chat 的核心 IA）：新对话按钮 + 「最近」会话列表（活动高亮、省略号），点击加载历史。
- **应用内会话持久化**：`/agent/run` 现在确保 thread 存在（首条用户消息作标题）、追加 user 与 assistant 消息到 `ConversationRepo`；`/threads` + `/threads/:id/messages` 回读。SDK 加 `listThreads`/`threadMessages`。
- **思维链**：流式拆分 `<think>…</think>` → 可折叠「思考过程」块（生成中默认展开）；兼容 provider 的 reasoning 事件。
- **工具调用卡片**：状态方块（运行=蓝脉冲/完成=绿勾/失败=红）+ 等宽工具名 + 可展开「参数/结果」code 块。
- **模型选择器**显示友好名（本地模型去路径/扩展名）。
- **修复真实 bug**：SSE 端点用 `req.raw.on("close")` 检测断开 —— 但对 POST 它在请求体读完即触发，导致**长下载被立即 abort**（"This operation was aborted"）。改为 `reply.raw.on("close")`（响应 socket 关闭）。下载/对话/agent/v1 四处均修。
- **Playwright 真机验证**：下载 Qwen3-0.6B(Q4)→ 经 llama-server 加载 → 浏览器发消息 → 思考过程实时流出 → 会话进入左栏历史 → 点击重新加载持久化历史 → 模型名显示为 `Qwen3-0.6B-Q4_K_M`。截图逐步确认。
- 63 测试全绿、build(11)/typecheck/lint(0)。

### 2026-06-13（续）— UI 细节：图标库 + Markdown 渲染
- **图标改用 lucide-react**（与 Unsloth Studio 一致；Unsloth 用 lucide-react 42 处 + hugeicons）。`icons.tsx` 以现有命名再导出 lucide（MessageSquare/Package/SlidersHorizontal/Send/Sparkles/Brain/Wrench/Check/Plus/ChevronRight…），组件零改动、笔画统一。
- **助手消息 Markdown 渲染**（react-markdown + remark-gfm，对齐 Unsloth 的 streamdown）：标题/列表/**粗体**/`行内代码`/```代码块```/表格/引用/链接，配白蓝样式（代码块深色、列表 marker 蓝色、链接蓝色下划线）。用户消息保持纯文本。
- Playwright 验证：lucide 图标渲染清晰；demo markdown（粗体/行内代码/标题/列表/代码块）正确渲染。

### 2026-06-13（续）— UI 精修一轮（基本达标）
- **代码块语法高亮**：rehype-highlight + highlight.js（atom-one-dark 主题），助手消息里的代码块着色。
- **消息复制按钮**：助手消息 hover 显示复制按钮（复制后短暂变 ✓）。
- **流式光标**：生成中末尾蓝色闪烁光标。
- **自动滚动**：消息变化时滚到底部。
- **会话删除**：会话项 hover 显示垃圾桶 → 删除（后端 `DELETE /threads/:id` + `repo.deleteThread` + SDK `deleteThread`）。
- **下载进度条**：模型下载显示蓝色进度条 + 速率。
- Playwright 真机逐项验证：代码高亮（Qwen3 输出 JSON 着色）、会话删除（列表更新）、Markdown、会话历史持久化、模型 Hub 卡片 + 本地模型加载、lucide 图标。63 测试/build(11)/typecheck(19)/lint(0) 全绿。

### 2026-06-13（续）— 按 Unsloth 真实截图重构为左侧栏布局
- 用户给出 Unsloth Studio 完整截图：纠正为 **左侧固定侧栏**（之前误用顶部 pill 栏）。
- 重构：左侧栏 = logo → 「新对话」(pencil) → 主导航（聊天/模型/设置，激活态蓝色软底 + 左侧蓝色 accent bar）→ 「最近」会话历史（仅聊天页）→ 底部 profile 卡片（头像 + EasyWork + 连接状态点，点击弹连接编辑）。会话状态提升到 App，Chat 变纯聊天面，threadId 变化时加载历史。
- Playwright 真机验证：左侧栏结构与 Unsloth 一致；聊天页显示会话历史 + 活动高亮；**向量记忆生效**（模型答"我是一只叫 Mimi 的橘猫"，召回了此前记忆）；设置页 profile 正确置底、记忆显示"已启用 768 维"。63 测试/build/typecheck/lint 全绿。

### 2026-06-13（续）— 对照 Unsloth 聊天窗口精修
- 依据 Unsloth Chat 截图对齐聊天窗口细节：
  - **助手消息无气泡**（贴背景纯文本，仅用户消息是气泡）—— 关键差异已修。
  - **聊天头**：绿色状态点 + 模型名 + chevron（极简 select，无边框）。
  - **输入区工具条**（仿 Unsloth 的 + / Think / Search / Code / mic / 发送）：`+`附件、`思考`/`联网`/`代码` 切换 pill（激活态蓝色软底）、麦克风、圆形上箭头发送。**「思考」已接 Qwen3 `/think`//`no_think`**；联网/代码为占位切换（带 tooltip）。
  - **底部免责声明**："本地 AI 也可能出错，请自行核实重要信息。"
- Playwright 真机验证：助手 markdown 无边框列表、工具条与激活 pill、状态点头部、底部提示，均与 Unsloth 布局一致（白蓝）。63 测试/build/typecheck/lint 全绿。

### 2026-06-13（续）— 接通工具能力 + 仿 Unsloth 实现
- **Web 搜索工具**（`@ew/tools` `web_search`，仿 Unsloth：`query` 搜 DuckDuckGo / `url` 取页正文）。直测返回真实结果（标题+URL+摘要）。
- **工具开关门控**：`/agent/run` 加 `excludeTools`；UI 的「联网」关 → 排除 `web_search`/`http_get`（开则提供给模型）。runAgent 据此过滤工具集。
- **Think 模式**：「思考」开关经 `think` 标志传给 daemon，注入 `/think`//`no_think` 给模型（Qwen3）——**不污染持久化的用户消息/会话标题**（之前直接拼进 content 导致标题带 /think，已修）。
- **Token 用量**：引擎 `usage` 事件经 agent loop 转成 `AgentEvent.usage`，聊天头显示 `↑prompt ↓completion`。
- **思考耗时**：检测 `</think>` 计算时长，思考块显示「思考了 N 秒」。
- Playwright 真机验证：思考了 2 秒、token ↑283↓276、联网工具可用、会话标题干净、borderless markdown。63 测试/build/typecheck/lint 全绿。

### 2026-06-13（续）— Web 来源 chips / 侧栏折叠 / 上下文进度条
- **Web 搜索来源 chips**（仿 Unsloth "Used tool: Searched…" + 来源 chips）：`web_search` 的 `ToolResult.display` 携带 `{title,url}[]` → 经 AgentEvent 流到 UI；助手消息里渲染「🌐 已搜索 "query"」+ 来源 chips（favicon via google s2 + 标题，点击新窗口打开）。
- **侧栏折叠**：标题栏 PanelIcon 切换；收起为 64px 图标栏（logo/新对话/导航/profile 仅图标，隐藏标签与历史）。
- **上下文用量进度条**：`LocalServerManager.contexts()` 暴露每模型上下文长度 → `/models.context` → UI 头部显示 `promptTokens / maxContext`（如 284 / 4.1k）+ 蓝色进度条。UI 加载模型时按 GGUF `contextDefault`（封顶 8192）传 contextSize。
- Playwright 真机验证：来源 chips（favicon 正常加载）、折叠图标栏、上下文条「284 / 4.1k」均正确。63 测试/build/typecheck/lint 全绿。

### 2026-06-14 — 对照 Unsloth Studio 的推理侧能力补齐（一轮系统性 parity）
逐项对比参考实现后，按优先级修复（每项带单测，全程 build/typecheck/lint/vitest 绿）：
- **配置持久化**：provider 列表 + MCP server 配置落 SQLite `settings` 表，daemon 重启后恢复（此前仅内存，重启即丢）。
- **采样参数补齐**：`ChatRequest` 新增 `topK/minP/repeatPenalty/frequencyPenalty/presencePenalty/reasoningEffort`，openai-compatible 透传（`top_k/min_p/repeat_penalty` 走 llama-server 扩展字段）；`/agent/run` 与 `/v1` 均接受。
- **SSRF 防护**：`http_get`/`web_search` 取页改用 `safeFetch`——拒私网/环回/链路本地/云元数据地址，DNS 解析校验，重定向逐跳重校验。
- **模型 LRU**：`LocalServerManager` 加最大常驻数（`EW_MAX_LOADED_MODELS`，默认 3）+ 使用即触碰的 LRU 淘汰，防 OOM。
- **Agent loop 对齐**：max-iter 8→25；累计重复/无效调用达上限强制"无工具最终回答轮"；noop 分类 nudge；one-shot 工具（render_html）。
- **真实工具审批**：`SseApprovalGate` + `/agent/approve` 端点 + UI 弹窗（允许/总是允许/拒绝），替代全自动放行；超时/中断按拒绝。
- **Anthropic 兼容 `/v1/messages`**：请求/响应/流式（message_start→content_block_*→message_delta→message_stop）双向翻译，tool_use/tool_result 互转，复用同一 engine。
- **gpt-oss harmony**：`HarmonyParser` 解析多通道（analysis→reasoning / final→text），兜底原始 `<|channel|>` token；`reasoning_content` 已映射。
- **记忆热重载**：`LocalMemoryProvider.startWatching()` 监听分层 markdown，用户手工编辑回灌索引（变更才重嵌，幂等防自激）。
- **文档知识库 RAG**：`@ew/core` 新增 `rag/`（分块 + 嵌入 + **RRF 混合检索**）+ `search_knowledge_base` 工具 + 首轮自动注入 + `/kb` CRUD + UI 上传/管理 + 引用来源面板。
- **render_html 工件**：one-shot 工具，UI 沙箱 iframe 渲染。
- **MCP 加固**：stdio 默认禁用（`EW_ALLOW_STDIO_MCP=1` 开启）+ 调用前 inputSchema 轻量校验。
- **UI**：图片上传打通多模态（base64 content parts → mmproj）；Settings 增 KB/Skills 区；引用/工件/审批面板。
- **文档**：CLAUDE.md 修正过期表述（Electron→Tauri、node-llama-cpp→llama-server、better-sqlite3→node:sqlite、sqlite-vec→JS 余弦）。
- 结果：**98 测试全绿**，typecheck 19/19，lint 0 error。
- **仍未做**：python/terminal 代码执行沙箱（Unsloth 有；安全敏感、默认关，留作专门设计）；IM 连接器 Discord/WeCom/飞书（**非 Unsloth 功能**，属 EasyWork 自身路线，需实盘凭证联调）。

### 2026-06-14 — 记忆 LLM 事实抽取
- **`observe` 升级**：在启发式会话摘要之外，新增可选 LLM 事实抽取。`@ew/memory` 加 `FactExtractor`/`ExtractedFact` 类型与 `LocalMemoryOptions.extract`（注入式，保持本包仅依赖 `@ew/shared`）。
- **`@ew/core` `buildFactExtractor`**：复用当轮对话模型（`MemoryProvider.observe` 增可选 `model`，agent loop 透传 `input.model`），经 `responseFormat: json_object` 把对话抽成持久事实 → user-profile/agent-memory/skills。含括号平衡 JSON 截取（容忍围栏/前后缀）、分层校验、模型未路由/解析失败安全降级为仅摘要。
- **去重防膨胀**：候选事实与同层已有事实双向词法重叠 ≥0.85 跳过 + 同批内去重；抽取器拿到既有事实供模型自行去重。
- 结果：**109 测试全绿**（新增 memory observe 抽取/降级 2 例 + core fact-extractor 5 例），typecheck 19/19。

### 2026-06-14（续）— 借鉴 Hermes Agent（会话/记忆四项）
对照 NousResearch Hermes Agent（SessionDB + FTS5 完整历史、MEMORY.md/USER.md 有界自治记忆、冻结快照）补齐四项：
- **tool 往返逐条落库**：抽出 `ToolTurnRecorder`（`@ew/core` agent/）从 AgentEvent 流重建带工具的对话轮（assistant 含 toolCalls + 各 tool 结果），`/agent/run` 用它把工具往返也写入 `ConversationRepo`（此前只存 user+assistant 终稿）。对齐 Hermes“完整历史含 tool_calls/results”。
- **FTS5 会话全文搜索**：`messages` 表加 `messages_fts`（trigram 分词，中英文子串匹配）+ `searchMessages`（≥3 字符走 FTS5 bm25+snippet，更短如中文 2 字词走 LIKE 回退；删库清索引）。新增 `session_search` 工具（search / browse-thread / list-threads 三态，直接查 DB 不经 LLM）。`ConversationRepo` 接口加 `searchMessages` + `MessageSearchHit`。
- **有界 + 模型自治记忆工具**：`manage_memory`（add/replace[子串定位]/remove），分层字符上限（user-profile 1375 / agent-memory・skills 2200，参考 Hermes USER.md/MEMORY.md），近限报错逼模型合并而非静默膨胀。与被动 LLM 抽取互补。
- **冻结快照注入**：`buildMemorySnapshot` 把全局记忆（user-profile/agent-memory/skills）渲染成会话期固定的系统块置顶注入（护 prefix cache）；动态 recall 经 `recallOptions.layers` 收窄到 session-summary，避免与快照重复注入全局记忆。manage_memory 改动本会话不变、下会话生效（与 Hermes 一致）。
- 接线：`/agent/run` 常驻 `manage_memory` + `session_search` 工具，置顶注入快照，recall 仅取 session-summary。
- 结果：**119 测试全绿**（+10：FTS 搜索、session_search、manage_memory 有界、ToolTurnRecorder 重建、冻结快照），typecheck 19/19；改动文件 eslint 0 error。

### 2026-06-14（续）— 移除 session-summary + UI 渲染适配
- **移除 session-summary 记忆层**：`MemoryLayer` 枚举删 `session-summary`（仅剩 user-profile/agent-memory/skills 三个全局层）。会话历史已由 `ConversationRepo` 完整存档 + FTS5 全文检索（`session_search`）承载，截断摘要冗余。`LocalMemoryProvider`：`observe` 去掉摘要写入（仅保留 LLM 事实抽取，无抽取器时 no-op）；recall 默认分支收为纯全局层；`regenerateMarkdown`/`syncFromMarkdown`/`startWatching` 去掉 sessions 目录/分支；删 `truncate`/`sanitize` 死代码。`/memory` POST 校验枚举同步收窄。
- **关闭动态 recall**：agent loop 加 `recallOptions.enabled`（默认开，保留测试与通用调用语义）；`/agent/run` 设 `enabled:false`——全局记忆已由冻结快照置顶注入、历史由 session_search 检索，避免重复注入。
- **UI 渲染适配**：`Chat.tsx` 历史回放新增 `storedToUiMsgs`——把存档扁平消息（user / assistant[含 toolCalls] / tool[含 toolResults]）折叠回 UiMsg 气泡，重建工具卡（参数/结果/来源/引用/HTML 工件，FIFO 匹配结果到调用）。抽出 `toolDisplayPatch` 供流式与回放共用；用户消息图片从 parts 复原。`Memory.tsx` 删「会话摘要」标签页。
- 结果：**119 测试全绿**（更新 observe 测试为 no-op/吞错语义、buildMemorySnapshot 测试去 session-summary），typecheck 19/19，UI build 通过，改动文件 eslint 0 error。

### 2026-06-14（续）— 工作区模式（Codex/cowork 式编码 agent）
新增「工作区」模式：区别于聊天，在本地项目目录里读写文件 + 执行命令。计划见 `~/.claude/plans/codex-app-claude-cowork-federated-dawn.md`。
- **路径沙箱**（`@ew/tools` `path-sandbox.ts`）：`resolveWorkspacePath` 仿 `ssrf.ts` 拒绝越界——`..`/绝对路径逃逸 + 符号链接逃逸（对已存在前缀 realpath 再校验）。
- **fs 工具族**（`@ew/tools` `fs-tools.ts`）：`fs_list/fs_read/fs_grep`（只读）+ `fs_write/fs_edit`（写，带 LCS unified diff display）；二进制嗅探、大小/匹配截断、唯一匹配歧义保护；纯函数 `listDir/readFileSafe` 供端点复用。
- **命令执行**（`@ew/tools` `exec-tool.ts`）：`run_command` —— `spawn(shell:true, cwd=工作区根)`，流式 stdout/stderr 经 `tool-progress` 事件，超时 SIGKILL、abort、输出截断。loop 加 `onToolProgress`→`ctx.emit` 旁路（不改 generator）。
- **可选审批策略**（`@ew/core` `workspace-approval.ts`）：`workspaceTools(mode)` 把 read-only/approve-each/auto-edits/full-auto 映射到各工具 `requiresApproval`；read-only 靠不注入写/exec 工具。
- **持久化 + 端点**：复用 `projects` 表（迁移加 `workspace_dir/approval_mode/updated_at` + project CRUD）；`/projects` CRUD、只读 `/workspace/:id/fs/list|read`（经沙箱）；`/agent/run` 加 `projectId` → 解析工作区根覆盖 `workspaceDir` + 按策略注入 fs/exec 工具 + 注入 `instructions`/`AGENTS.md`/`CLAUDE.md` 系统提示 + thread 关联 project。
- **SDK**：`listProjects/createProject/updateProject/deleteProject` + `wsList/wsRead` + `runAgent` 加 `projectId`；`threadMessages` 类型补 toolCalls/toolResults。
- **前端**：抽 `lib/agent-stream.ts`（共享数据模型 + 纯函数 + `applyAgentEvent` 归约器，Chat 改复用，含 `tool-progress`）；新页 `Workspace.tsx`（文件树懒加载 + 只读文件查看器 + DiffCard 行级着色 + ExecCard 流式终端 + 审批策略下拉 + 复用审批弹窗）；App 加「工作区」tab + 项目侧栏 + 新建（`lib/desktop.ts` 桌面 Tauri 文件夹选择 / 浏览器路径输入回退）；图标/CSS。
- **Tauri 壳**：`select_workspace_dir` 命令 + `tauri-plugin-dialog` + capabilities（无 Rust 工具链，未编译验证）。
- 结果：**146 测试全绿**（+27：path-sandbox 5 / fs-tools 8 / exec-tool 7 / workspace-approval 4 / conversation project CRUD 1 / 端点+端到端 fs_write 写盘 2），typecheck 19/19，UI build 通过，改动文件 eslint 0 error。端到端验证：带 project 的 `/agent/run` 经 fs_write 工具真实写盘 + diff 透传。
- **遗留（v2）**：工作区多会话/历史回放（现一工作区一固定 thread）；内嵌可编辑编辑器；文件 watch 实时刷新；diff「接受/拒绝单改动」；大仓库虚拟滚动 + git 状态；交互式终端输入。

### 2026-06-14（续）— 工作区 git 集成 + Codex 风格 UI 重设计
参照 Codex 桌面应用截图把工作区改为 git 感知的编码界面：中对话 + 右侧带行号 diff 审查面板。
- **后端 git 服务**（`@ew/core` `git/git.ts` `GitService`）：`status`（porcelain -z 解析 + numstat 计数 + untracked 行数近似 + 分支）/ `diff`（tracked / staged / untracked --no-index）/ `stage`·`unstage`·`stageAll`·`unstageAll` / `commit` / `revert`（tracked restore + untracked 删除）/ `revertAll` / `branches` / `switchBranch`。`execFile git`，cwd=工作区根，非 repo 优雅降级，全不抛。
- **端点**（`app.ts`）：`/workspace/:id/git/{status,diff,branches}`（GET）+ `{stage,unstage,revert,commit,switch}`（POST），经 `projectRoot` 解析。**SDK** 加 `gitStatus/gitDiff/gitBranches/gitStage/gitUnstage/gitRevert/gitCommit/gitSwitch` + `GitFile`/`GitStatus` 类型。
- **前端重设计**（`Workspace.tsx` 重写）：两栏=中对话 + 右 git 审查面板。顶栏：项目名/目录 + 分支 chip + **+增/-删聚合统计** + 模型选择。对话：用户右对齐 pill 气泡、`run_command`→终端卡（流式）、`fs_write/edit`→文件改动 chip、思考折叠；输入栏内置审批策略下拉。**审查面板**：未暂存/已暂存分组、每文件 `path +N -M` 行 + 悬停暂存/取消/还原、展开显示**新旧行号 + 绿/红语法 diff**（`parseUnifiedDiff` 按 @@ hunk 重建行号）、全部暂存/还原、提交说明框 + 提交。每轮 agent 结束自动刷新 git 状态。
- 接线：App 渲染 `<Workspace>`（项目侧栏不变）；图标加 GitBranch/Undo2/GitCommit。
- 结果：**154 测试全绿**（+8：GitService 7 单测对真实 git + git 端点 HTTP 流程 1），typecheck 19/19，UI build 通过，改动文件 eslint 0 error，**Rust `cargo check` 通过**。dev:desktop 实机拉起验证。
- **遗留（v2）**：暂存区内编辑、commit amend、diff 内联折叠未改动行（现全量展示）、冲突/合并、push/pull、提交历史。

### 2026-06-14（续）— code-review 修复（工作区/git）
高 effort 多角度评审后修复确认的 bug：
- **#1 安全（严重）**：git diff/revert/stage/unstage 端点之前把用户 path 原样传给 git → 可读/删工作区外文件（`git diff --no-index /dev/null /etc/passwd`、`revert ['../../x']`）。`GitService` 所有路径经 `resolveWorkspacePath` 校验（越界抛错）；diff/revert 用根内绝对路径。
- **#7**：git branches/stage/unstage/revert/commit/switch 端点补 try/catch → 未知/无目录项目返回 400 而非 500。
- **#2**：run_command 流式输出之前 callId 用 `exec-时间戳`，与工具卡 id 不匹配 → 终端无输出。`ToolExecContext` 加 `callId`，loop 执行前设 `ctx.callId=tc.id`，exec 用它发 tool-progress。
- **#4**：exec 改 `detached` + 超时/中断 `process.kill(-pid)` 杀整棵进程树（原来只杀 shell，孙进程泄漏）；显式 abort 监听。
- **#5**：重命名文件计数为 0 —— numstat 的 `old => new`/花括号形式归一到新路径，与 status 对齐。
- **#6**：fs_list/fs_grep 在符号链接根下产出越界相对路径 —— 用 realpath 根作 `path.relative` 基准。
- **#8**：fs_read 行范围之前绕过 MAX_READ_BYTES —— 字节上限对所有路径生效。
- **#3**：聊天/工作区切换会话时在途流串到新会话 —— App 给 Chat/Workspace 加 `key`（切换即重挂载）+ 卸载时 `AbortController.abort()` + runAgent 传 signal + abort 时不写错误。
- **#9**：FileRow 缓存 diff 不刷新 —— key 含 `adds-dels`，文件改动后重挂载重取 diff。
- **#10**：refreshGit 每个 tool-end 都触发（N+1 次、每次多个 git 子进程）—— 仅 fs_write/fs_edit/run_command 后触发 + 轮末一次。
- **契约/死代码**：im-connectors `FakeRepo` 补齐 project CRUD + searchMessages（之前 `implements ConversationRepo` 已是潜在 tsc 错，被 esbuild 掩盖）；移除从未渲染的 fs-tools LCS `unifiedDiff`（UI 用 git diff）。
- 结果：**157 测试全绿**（新增 git 重命名计数 + 路径越界 diff/revert + 端点 400），typecheck 19/19，UI build 通过，改动文件 eslint 0 error，Rust 编译通过。

## 待决 / 风险

- 原生 addon ABI 与 asar `asarUnpack`（#1 打包风险）→ 集中原生依赖 + `@electron/rebuild` + 三平台冒烟测试。
- GPU 后端分发膨胀 → 默认仅 CPU+Metal，CUDA/Vulkan 按需下载。
- 个人微信无官方 API → 只做企业微信。
