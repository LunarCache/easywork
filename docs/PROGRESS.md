# 项目进展（PROGRESS）

> 每完成一个里程碑更新此文件。最新在上。

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
- **`/v1`·`/chat/stream` 决策**：**保留薄引擎**（EngineRegistry + LlamaServerEngine/OpenAICompatibleEngine）。它们是 OpenAI 兼容**服务端**，而 pi-ai 是**客户端**库，二者职责相反；用引擎实现服务端是正确选择，非遗留债。
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
- **`@ew/im-connectors`**：`ChannelConnector` 抽象 + `ConnectorHost`（inbound→resolveThread→取历史→runAgent→批量回复→持久化）+ **Telegram 连接器**（Bot API 纯 HTTP 长轮询，注入 fetch 可测）。Discord（需 gateway ws）/WeCom/Feishu 待补。
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
