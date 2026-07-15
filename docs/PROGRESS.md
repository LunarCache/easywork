# 项目进展（PROGRESS）

> 每完成一个里程碑更新此文件。下方「状态总览」是滚动结论，再往下是按时间倒序的里程碑日志。

## 状态总览

### ✅ 已完成

- **核心守护进程**（`@ew/core`）：Fastify HTTP + SSE，托管 pi-coding-agent 内核（`SessionHost`，按 threadId 串行化），无头可运行（`easywork serve`）。
- **本地推理（router 模式）**：统一 `llama`（llama.app）的 `llama serve --models-dir` **单路由进程**，按请求 `model`（= 模型子目录名）路由、按需 auto-load、`--models-max` LRU 淘汰（文本 / 视觉）；嵌入模型走独立 `llama serve -m --embedding` 进程。经典每模型一进程的 `llama-server`（含 brew llama.cpp）**已完全移除**——只支持 llama.app 统一 `llama`。HF 搜索 / 断点续传下载 / GGUF 头解析。
- **云端推理**：pi-ai 内置 provider + 自定义多协议兼容端点；provider 提供默认 API / Base URL，模型可独立覆盖以支持聚合商内 OpenAI 与 Anthropic-only 模型并存；模型目录支持自动/手动模板绑定，运行时继承名称 / reasoning / thinking map / 输出上限，UI 选择模板时把上下文与模态复制进逐模型配置，报文 `compat` 保持协议隔离；云端流式/非流式统一经 pi-ai（含 OAuth）。
- **多协议网关**：`/v1/chat/completions`（+stream）/ `/v1/embeddings` / `/v1/models`（OpenAI）+ `/v1/messages`（Anthropic）；本地透传、云端经 pi；本地 proxy、云端 pi 与 engine fallback 的全部 SSE 写口均具备断流 error listener 和 ended/destroyed 守卫。
- **Agent 工具**：内置工具（time/calculator/http_get+SSRF/explore_web）、MCP（stdio+HTTP）、Skills，全桥成 pi customTools；审批 4 档 + 工作区路径限定。
- **工作区模式**：本地项目目录读写文件 / 跑命令 + git 改动审阅面板；聊天模式工件目录。对话区与工作区共用右侧「工作台坞」（改动 / 文件 / 浏览器）；Desktop 多实例真终端由标题栏独立入口在对话区底部打开，并独立于 Agent 工具命令。
- **记忆（作用域化）**：Core Memory = User Profile / Agent Notes；每工作区私有 conventions / decisions / pitfalls；derived facts 保留来源所有权，manifest 有界；sqlite-vec ⊕ 词法召回，markdown 可手改回灌。外部 provider 当前仅为宿主注入 seam，Desktop / CLI 无配置入口，Mem0 仍是骨架；注入后也只做 additive、受限且可关闭的召回。
- **Skill 学习闭环**：Chat `/learn` / 设置显式 Learn + restricted background review → pending Candidate → 用户审核批准 → 全局/工作区原子激活；支持证据、package 安全验证、来源删除、乐观锁 patch、使用反馈、pin、stale、可恢复归档、快照与回滚。
- **思考能力与过程**：`reasoning` 能力由运行时模型投影到 UI，推理模型首次默认中档、显式关闭按模型持久化；reasoning 内容落库并跨会话回放（不回喂模型）。
- **桌面 / UI**：Tauri 2 外壳（sidecar 拉起 daemon，并以 `portable-pty` 托管窗口级真终端）+ React 19 前端（"Agent Tasks" 工作台设计语言，明暗双主题）；展开式侧栏（项目/对话分组）+ 三栏可拖拽 + 可调宽「工作台」面板（无标签空态快捷入口、标题栏可关闭动态标签、HTML 直达浏览器、文件主从 / 放大双栏、窄屏浮层）+ 标题栏独立终端按钮与对话区底部多终端面板 + 外部渠道聊天优先收件箱（唯一顶层标题、紧凑列表头、统一渠道品牌图标）+ 整页设置（`SettingsHost` page-host，模型/渠道/Skills/MCP/记忆 keep-alive 内嵌）+ 统一弹层；WebView 启用显式 CSP，保留 IPC/daemon/预览来源并禁止远程脚本、对象插件与表单提交。
- **外部渠道**：`@ew/im-connectors` Channel Gateway（adapter registry + 配置/状态 + allowlist + webhook 分发），core 侧 `ChannelOperations` 统一连接器生命周期、Feishu/WeChat 扫码 setup session、收件箱 read model 与 SSE invalidation；Telegram 已迁入同一抽象并支持可取消 long-poll；Feishu/Lark 默认走官方 SDK WebSocket 长连接并支持扫码创建应用，高级模式保留 webhook（URL verification、token/signature、加密回调解密、文本收发），且 public webhook 只在 `transport:webhook` + 验证 secret 配置完整时启用；WeChat 对齐 Hermes 的腾讯 iLink Bot API 扫码登录 + long-poll，保存 sync/context token；渠道 secret 已迁到 macOS Keychain / Linux Secret Service / Windows 当前用户 DPAPI，旧 SQLite 明文自动迁移并去敏；Discord / 企业微信待补平台 adapter。
- **存储**：`node:sqlite`（ConversationRepo + FTS5 全文检索 + 设置 / provider / MCP / IM 非敏感配置）+ 系统渠道密钥存储。
- **命令行（CLI）**：SEA daemon 二进制同时也是终端客户端 —— `repl`（交互多轮 + 工具审批 y/n + Ctrl-C 中断本轮）/ `run`（一次性；无位置参数时可从 stdin 读取，`-t` 续接会话）/ `models ls·pull·rm` / `thread ls·show·rm` / `mem ls·search·rm` / `serve` / `status` / `stop`；自动拉起/发现本机 daemon，复用 `@ew/sdk` 打 HTTP；`EW_BASEURL` 可直连远端。macOS / Windows 安装包仅把该二进制作为 desktop sidecar，不会把 `easywork` 命令安装到 `PATH`。
- **打包发布（macOS / Windows）**：daemon 打成单文件原生二进制（Node SEA，运行免 Node）；Tauri 出 macOS Apple Silicon dmg 与 Windows x64 NSIS/MSI（内置 daemon + sqlite-vec）；`install.sh` / `install.ps1` 安装后自动备齐 llama 运行时；版本、SEA `/health` 与 Windows 产物契约均为 CI 门禁。

### 🚧 待做

- **渠道 adapter**：Discord / 企业微信待补（需实盘凭证联调）；Channel Gateway 抽象、Telegram adapter、Feishu/Lark WebSocket + webhook adapter、WeChat iLink QR + long-poll adapter 已落地。个人微信走腾讯 iLink bot 身份，群聊默认关闭；企业微信仍走后续 WeCom adapter。
- **打包发布收尾**：macOS Apple Silicon 与 Windows x64 构建链已落地；Intel / Windows ARM64 / Linux 安装包 + 代码签名 / 公证 + 自动更新待做。
- **代码执行沙箱**：python / terminal 的独立 OS 级隔离（当前经 pi `bash` 工具 + 审批 4 档把守，无独立沙箱）。
- **密钥存储**：渠道 secret 已迁系统安全存储；provider / MCP key 仍在 SQLite `settings`，待后续迁移。
- **工作区 v2**：多会话回放 / 提交历史 / push-pull / per-hunk 暂存均已完成；仅剩内嵌可编辑编辑器（按需）。
- **CLI 安装与跨平台开发脚本**：macOS 安装器尚未把 sidecar 链接到 `PATH`；desktop 的 `EW_DAEMON_ENTRY=... tauri dev` 仍是 POSIX 写法，Windows 源码开发需改成跨平台启动脚本。

---

## 里程碑日志

> 以下条目按当时实现原样记录；其中出现的旧类名、进程模型或测试数量仅代表对应日期的快照。当前状态以上方“当前状态”与最新里程碑为准。

## 2026-07-15 — 工作台无标签空态启动器

- **真实空态**：`WorkbenchViewSession` 新建时不再自动插入工作区“改动”或对话“文件”视图；手动打开工作台先显示无标签启动器，关闭最后一个标签也回到该空态而不收起抽屉。
- **快捷入口**：空态正文按当前界面语言提供新任务、浏览器和 Desktop 终端动作；新任务复用 App 既有任务切换，浏览器创建标准 Workbench view，终端只打开对话区底部的独立 `TerminalPanelSession`，浏览器运行时不暴露 PTY。
- **回归与视觉**：Vitest 锁定 session 的零视图初态和相邻关闭回退；Playwright 覆盖三个入口、最后标签关闭回落及平台能力隐藏；应用内浏览器实页检查动作列左对齐、垂直位置和顶层 chrome。全量验收为 Vitest **395 passed / 1 skipped**、Playwright **45 passed**，lint、typecheck 与 build 均通过。

## 2026-07-15 — 对话学习 Skill 收口为 `/learn`

- **入口收敛**：移除普通对话 composer 底栏的星光学习图标，把“从当前对话学习 Skill”迁入 Chat 专属 `/learn` 命令；Workspace 的共享 Slash palette 不展示该命令。
- **语义复用**：命令继续调用 `POST /skill-learning/prepare` 的 `kind:conversation + threadId`，只把生成的学习提示回填 composer；后续仍是普通 Agent turn，并且只能暂存待审核 Skill Candidate。
- **回归锁定**：Playwright 从用户界面验证旧图标消失、`/learn` 可见、请求绑定当前 Source Conversation 且返回提示正确回填。全量验收为 Vitest **395 passed / 1 skipped**、Playwright **44 passed**，lint、typecheck 与 build 均通过。

## 2026-07-15 — 收件箱局部标题与渠道图标收口

- **去除重复层级**：顶层标题栏已经显示“收件箱”，列表头不再重复大标题，只保留“外部渠道”分区标识和紧凑刷新动作。
- **图标统一**：刷新动作改用单箭头重载图标；会话列表、对话头与详情抽屉的渠道头像统一复用 `BrandIcon`，微信 / Telegram / Discord 显示正式品牌标志。
- **回归锁定**：Playwright 验证列表头不再出现重复 heading，并锁定新的刷新图标与既有整高拖拽边界；真实 Desktop 复核微信品牌图标在列表和对话头的尺寸与边框一致。全量验收为 Vitest **395 passed / 1 skipped**、Playwright **43 passed**，lint、typecheck 与 build 均通过。

## 2026-07-15 — 布局拖拽分隔线贯穿修复

- **全窗边界**：主侧栏拖拽热区向上覆盖标题栏且不再占用 flex 宽度；右侧工作台把热区 portal 到全局层，避开对话容器裁切，使同一条边界从窗口顶部贯穿到底部。
- **同类收口**：检查全部可调宽布局后，将收件箱列表也改为零占宽覆盖式热区和整高高亮；设置导航、文件树与终端边界不是可调宽分隔线，现有覆盖范围符合各自容器语义。
- **交互与回归**：三处均补齐 `separator` 语义、方向键调宽与持久化；Playwright 锁定顶部拖拽、整高命中、零额外间隔、设置页隐藏工作台热区及收件箱内部边界。全量验收为 Vitest **395 passed / 1 skipped**、Playwright **43 passed**，lint、typecheck 与 build 均通过。

## 2026-07-15 — Desktop 终端从右侧工作台独立

- **独立入口与布局**：标题栏右端在工作台开关左侧新增终端按钮；点击后终端在 Chat / Workspace 对话列底部展开，不再占用 SideDock 标签和宽度。
- **独立生命周期**：新增 `TerminalPanelSession`，统一 runtime 会话恢复、首次打开自动创建、多会话激活、相邻关闭回退与前台任务确认；`WorkbenchViewSession` 回归只管理改动 / 文件 / 浏览器。
- **主题一致性**：面板、工具栏与 xterm 都读取当前应用主题 token，浅色主题不再固定使用深色终端井；主题切换时 xterm 即时更新。
- **回归锁定**：定向 Vitest 覆盖恢复 / 创建 / 激活 / 关闭确认与恢复失败不误建重复 PTY，Playwright 覆盖独立入口、底部布局、多会话、隐藏 / reload 恢复与浏览器能力隐藏；全量验收为 Vitest **395 passed / 1 skipped**、Playwright **41 passed**，lint、typecheck、build 与 debug `.app` 构建均通过。

## 2026-07-14 — 自定义 Provider 逐模型混合协议

- **逐模型协议与端点**：provider 的 API / Base URL 降为默认值，`modelConfigs[]` 可逐项覆盖；设置页直接编辑每个模型的 API 协议和可选 Base URL，同一聚合商内的 OpenAI 与 Anthropic-only 模型无需拆分配置。
- **保守 OpenAI 兼容基线**：缺少同协议目录模板时不再按完整 OpenAI 能力发送 developer role、store、reasoning effort 等字段，避免仅接受 `system/assistant/user/tool/function` 的兼容端点返回 400。
- **思考字段归属**：云端思考报文完全交由 pi-ai 按有效模型协议 / compat 生成；`SessionHost` 只给本地 llama 注入 thinking 扩展，避免 MiniMax 等上游因统一注入 `thinking:{type:"disabled"}` 拒绝请求。
- **Cp 实盘验证**：保留 provider 级 OpenAI 默认协议，GLM 系列逐模型覆盖为 Anthropic Messages 及其根端点；13 个模型全部通过带 Agent 工具定义的 `/agent/run` 完整链路烟测，原 400 / 422 均消失。
- **全量验收**：lint、typecheck、build 全绿；Vitest **393 passed / 1 skipped**，Playwright **39 passed**；运行中 Desktop daemon `/health` 返回 200。

## 2026-07-14 — 五个深模块架构收口

- **Agent Turn**：Chat 与 Workspace 通过 `AgentTurnController` / `useAgentTurn` 共用单轮输入、SSE、取消、审批、usage、重试、compaction、工件和最终消息归并；页面只保留各自的布局、启动参数与领域投影。
- **Workbench View Session**：`WorkbenchViewSession` 统一拥有工作台标签、选中项、关闭回退、按 scope 隔离的终端会话、浏览器导航以及文件 / HTML 打开语义；`SideDock` 退回渲染和平台适配层。
- **来源对话与 Skill Candidate 生命周期**：`SourceConversationLifecycle` 把来源删除、在途屏障、derived facts 清理、历史/FTS/会话回收收进同一删除屏障与有序生命周期；`SkillCandidateLifecycle` 成为候选暂存、审批、拒绝、归档、恢复、回滚与来源失效的唯一状态迁移接口。
- **Provider Model Configuration**：Core 的 `ProviderModelConfiguration` 统一决定 provider-scoped route、上游模型身份、目录继承、协议隔离、最终 pi runtime model 与 `/models` 投影；ProviderManager、HTTP、pi registry、EngineRegistry 和 UI 只消费结果。旧 raw model id、等价 percent-encoded route 与公共 helper 导出仅作为有明确移除条件的兼容适配层保留。
- **文档与删除证明**：README、AGENTS、FEATURES、ARCHITECTURE、DESIGN 和派生 design-web 已同步；`CONTEXT.md` 只保留实现无关术语。原 Chat/Workspace 双份 turn loop、SideDock 生命周期分支、route 层来源删除序列和 candidate fake casts 均已移除，没有第二套语义实现。
- **全链路验收**：`git diff --check`、lint、typecheck、build、Vitest（**391 passed / 1 skipped**）、Playwright（**39 passed**）、Rust check/test、版本一致性、macOS arm64 SEA 构建与 `/health` smoke 全绿。Computer Use 真机复核 Chat、Workspace、顶层可关闭标签、HTML 直达 Browser、自定义地址规范化、真实 PTY 输入输出和云端 Provider 编辑页。

## 2026-07-14 — Desktop 多实例真终端

- **真实 PTY**：删除 SideDock 的 Agent 命令回放式伪终端；Desktop Rust 壳改用 `portable-pty` 启动用户默认 shell，前端以 xterm 渲染，通过 Tauri Channel 接收有序输出，并支持真实输入与 resize。旧 `/workspace/:id/exec`、`/chat/:threadId/exec` 与 SDK exec 方法一并移除。
- **多标签与目录语义**：每次从 `+` 选择终端都会创建独立标签和 PTY；工作区从项目根目录启动，对话从该 thread 工件目录启动。浏览器运行时不显示终端入口，Agent `bash` 仍走原审批 / 工作日志链路，绝不向用户 PTY 注入命令。
- **生命周期**：隐藏抽屉、切换标签 / 任务不结束会话，WebView reload 后按 scope 重新列出并附着当前应用进程内的终端；关闭标签结束对应 PTY，检测到前台任务先确认，退出 Desktop 统一回收。应用重启后不恢复旧终端。
- **回归锁定**：Rust 测试启动真实 PTY 验证输入 / 输出、多会话与标签编号；Playwright 覆盖 Desktop 能力探测、多个终端、输入 / resize、抽屉隐藏、切换任务、reload 重附着、关闭确认与浏览器运行时隐藏。`npm run lint`、`npm run typecheck`、`npm run build`、`cargo test` 全绿；`npm test` = **363 passed / 1 skipped**；`npm run test:e2e` = **39 passed**。

## 2026-07-14 — 工作台标签并入标题栏与 HTML 直达浏览器

- **同层 chrome**：SideDock 通过标题栏稳定 host portal 输出已打开标签、`+` 与放大动作，与抽屉按钮严格同一行；抽屉正文从第一像素开始归属当前视图。
- **标签生命周期**：所有标签带独立关闭按钮；关闭当前标签切到相邻标签，关闭最后一个标签收起抽屉，再次打开恢复上下文默认标签。
- **HTML 直达 Browser**：HTML 交付卡与文件行统一读取受控文件内容后直接进入浏览器标签，以 sandbox `srcDoc` 浏览，不再创建 FileViewer 预览 / 源码界面；Markdown 等非 HTML 文件保留原主从 / 放大双栏。
- **响应式细节**：`+` 菜单改为向左对齐展开，960px 浮层下完整留在 viewport 内。
- **回归锁定**：Playwright 覆盖标题栏同层布局、标签关闭 / 最后标签收起、HTML 直达 Browser、重复链接激活和窄屏菜单边界；`npm run lint`、`npm run typecheck`、`npm run build` 全绿；`npm test` = **363 passed / 1 skipped**；`npm run test:e2e` = **36 passed**。

## 2026-07-14 — 工作台顶层动态标签与可导航浏览器

- **顶层标签化**：删除固定“工作台”标题和第二层模式栏；顶行改为已打开视图标签，`+` 菜单在标签旁按需增加改动 / 文件 / 终端 / 浏览器，放大与关闭保留在最右侧。外部文件卡和消息链接会自动增加并激活对应标签。
- **动作归属视图**：文件目录 / 刷新、Git 统计 / 刷新下沉到各自内容头部，顶层不再是一块不可变化的通用工具栏。
- **浏览器可导航**：新增可编辑地址栏，裸域名自动补 `https://`，地址栏与外部导航统一只接受 http(s)；消息链接以带序号的导航事件进入工作台，重复点击同一链接也会重新激活并恢复目标地址。自定义地址、消息链接、复制、刷新和清空共用同一浏览器视图，切换标签后地址保持。
- **回归与视觉**：Playwright 覆盖动态标签、`+` 菜单、自定义地址导航、协议拦截、跨标签保持及消息链接重复导航；真实浏览器复核 420px 常驻列、960px 浮层、菜单不裁切和 iframe 实际加载。`npm run lint`、`npm run typecheck`、`npm run build` 全绿；`npm test` = **363 passed / 1 skipped**；`npm run test:e2e` = **35 passed**。

## 2026-07-14 — 工作台侧栏按 Codex Review 信息架构收口

- **模式直接可见**：移除二级启动菜单，工作台打开后直接呈现改动 / 文件 / 终端 / 浏览器模式栏；文件数量和 Git 统计与模式入口同层展示。
- **文件主从关系**：普通侧栏由文件列表进入独占详情，返回动作并入 FileViewer 唯一工具栏；放大态切成左侧独立滚动导航 + 右侧独立预览，不再把预览嵌进手风琴文件行，也不再出现两套文件标题。
- **尺寸与响应式**：宽屏侧栏支持 320–760px 拖拽并持久化；≤1100px 时标题栏入口继续可用，工作台改为右侧浮层而不是整块消失。
- **回归锁定**：Playwright 覆盖普通主从导航、放大双栏、单一预览工具栏、宽度拖拽持久化与窄屏浮层；真实浏览器截图复核宽屏 / 960px 两种布局。`npm run lint`、`npm run typecheck`、`npm run build` 全绿；`npm test` = **363 passed / 1 skipped**；`npm run test:e2e` = **34 passed**。

## 2026-07-14 — HTML 交付路径收敛

- **文件引用去重**：SideDock 对绝对 / 相对目标路径做统一分隔符与后缀匹配，同一文件不再同时出现“临时绝对路径项”和“列表相对路径项”；无法匹配的深层交付文件仍可按目标路径直接预览。
- **移除 `render_html`**：Agent 不再暴露内联 HTML 工件工具；HTML 产出统一写成对话文件，经「本轮交付」与 FileViewer 的预览 / 源码切换查看。旧会话中已经持久化的 HTML display 不再回放。
- **文件预览填充窗口**：SideDock 文件列表中的已展开项在普通侧栏与放大态都会使用剩余高度，不再受 520px 上限截断；其他文件行保持折叠，多文件浏览行为不变。

## 2026-07-14 — 对话轮次交付文件可见

- **逐轮归属**：普通对话在运行前后对专属工件目录做有界快照，将成功轮次最终仍存在的新增 / 修改文件写入对应助手消息；取消、失败或仅删除文件不会形成交付清单。
- **行内展示**：助手答复下方新增「本轮交付」卡，显示文件类型、状态与大小；前三项直接展示，其余按需展开，点击复用右侧工作台文件预览。
- **持久化与实时一致**：`StoredMessage.artifacts` 支持历史回放，提交成功后的 `AgentEvent.artifacts` 让当前轮次即时更新；CLI 同步输出交付摘要。
- **边界**：MVP 仅快照普通对话工件目录，避免扫描整仓库；工作区继续使用现有 Git 文件改动卡与 diff 视图。

## 2026-07-14 — 记忆页收敛外部 Provider 空状态

- **可操作状态优先**：未配置 Additive Memory Provider 时不再显示突兀且无入口可操作的“外部记忆 · 未配置”；Provider 实际由宿主注入后仍显示身份、运行状态与启停开关。
- **能力边界澄清**：Desktop / CLI 当前没有外部记忆接入入口；`CreateCoreOptions.deepMemoryProvider` 是唯一配置来源，`GET/PATCH /memory/provider` 只查询 / 启停宿主已注入实例，Mem0 适配器仍是非用户态骨架，暂不作为产品功能开放。
- **回归锁定**：Playwright 通过真实 daemon 进入记忆页，断言默认未配置场景不存在外部 Provider 状态块；向量 / 词法召回状态与记忆主流程保持不变。
- **验证**：`npm run lint`、`npm run typecheck`、`npm run build` 全绿；`npm test` = **350 passed / 1 skipped**；`npm run test:e2e` = **30 passed**；设计文档派生 HTML 保持同步。

## 2026-07-14 — HF 镜像开关与模型搜索错误可见性

- **统一来源切换**：通用设置新增持久化 HF 镜像开关；`HFClient` 动态基址统一覆盖模型搜索、变体文件树、普通 GGUF 下载与记忆 nomic embedding 下载，默认仍为 `huggingface.co`，启用后使用 `hf-mirror.com`。
- **错误可见性**：模型搜索捕获 SDK/HTTP 异常并显示明确错误与镜像引导，不再静默呈现空白页面；镜像设置读取或保存失败也会就地提示。
- **回归锁定**：Core 测试覆盖动态 URL 与跨重启持久化，SDK 测试覆盖读写路由，Playwright 覆盖通用页开关跨刷新保持与搜索 502 错误提示。
- **验证**：`npm run lint`、`npm run typecheck`、`npm run build` 全绿；`npm test` = **350 passed / 1 skipped**；`npm run test:e2e` = **30 passed**；设计文档派生 HTML 已同步。

## 2026-07-13 — 移除文档知识库 RAG

- **硬删除能力**：移除 `packages/core/src/rag/`、`/kb/*` HTTP 路由、`search_knowledge_base` customTool、SDK/CLI 知识库命令与 Chat 请求字段，不保留 feature flag 或空 adapter seam。
- **宿主收口**：`SessionHost`、session resources、Core context 与 `createCore` 不再创建或注入 `KnowledgeBaseStore`；原来和知识库混在同一文件的 Skills 路由独立为 `server/routes/skills.ts`。
- **UI 与测试清理**：删除知识库设置页、Chat 知识库 pill、引用来源专用渲染与样式；移除 RAG 单测和知识库 e2e，保留并重命名 Skills e2e。
- **数据安全**：停止读取旧 `kb.db`，但启动和卸载流程都不会主动删除用户已有文件，便于手工备份或回退。
- **保留能力**：记忆的 sqlite-vec / 词法召回、会话 FTS5 检索、用户图片、多模态聊天和通用文件预览保持不变。
- **验证**：`npm run lint`、`npm run typecheck`、`npm run build` 全绿；`npm test` = **345 passed / 1 skipped**；`npm run test:e2e` = **28 passed**；设计文档派生 HTML 已同步。

## 2026-07-13 — Windows x64 构建与发布关键路径门禁

- **Windows 构建**：普通 CI 在 `windows-latest` 构建 NSIS；`v*` release 同时构建 NSIS + MSI 并上传，sidecar 为 `easywork.exe`，随包携带 `vec0.dll`。
- **跨平台 SEA**：构建脚本从 shell 字符串改为 Node CLI + 参数数组调用，并固定本地 `postject`；兼容 Windows 路径及 Node 24/26 SEA argv 差异。
- **关键路径测试**：新增 Windows workflow、发布产物契约和 daemon smoke 测试；真实 SEA 冒烟会启动打包二进制、请求 `/health` 后回收进程。
- **安装器**：`install.ps1` 启用 Windows x64 Release 下载，优先 NSIS，MSI 回退走 `msiexec`。
- **验证**：本机真实 macOS SEA 重建与 `/health` smoke 已通过；Windows 原生 NSIS/MSI 由新增 GitHub Actions runner 验证。

## 2026-07-13 — SSE 断流、渠道密钥、Desktop CSP 与发布版本收口

- **SSE fallback 加固**：OpenAI / Anthropic engine fallback 分支补齐 `raw.on("error")` 和 `writableEnded/destroyed` 写入/结束守卫；真实 HTTP 客户端中途断开回归测试在修复前分别捕获 3 / 2 次关闭后写入，修复后归零。
- **渠道密钥迁移**：新增 `ChannelSecretStore`，macOS 走 Keychain、Linux 走 Secret Service、Windows 走当前用户 DPAPI；SQLite 只保存非敏感 connector 配置，GET 通过独立 read view 返回 `secretKeys` 且不回显 secret。旧明文启动时先迁安全存储再擦除，空白编辑保留旧值，删除 connector 同步清理。
- **WebView CSP**：Tauri 从 `csp:null` 改为显式 policy，放行 IPC、本地 daemon、data/blob 媒体与沙盒 frame，禁用远程 script、object、form 和外部 frame ancestor；配置测试与 `cargo check` 通过。
- **版本一致性**：root npm、desktop npm、Tauri config、Cargo.toml/Cargo.lock 统一到 `0.4.4`；新增 `release:check-version`，release workflow 在构建 dmg 前校验 `vX.Y.Z` tag 与所有发布清单一致。
- **验证**：定向 SSE / Channel Operations / IM Gateway / CSP / release version 测试全绿；`npm run lint`、`npm run typecheck`、`npm test`（349 passed / 1 skipped）、`npm run build`、`cargo check` 与 Playwright 29 条 UI e2e 全部通过。

## 2026-07-13 — Composer 无边框控件与上下文悬停详情

- **视觉收口**：Chat 与 Workspace composer 的思考 / 联网 / 知识库、工作区 / 分支、模型、审批策略和附件状态控件统一移除描边，保留输入卡外框作为整体边界。
- **上下文圆环**：移除圆环旁常驻百分比，只保留环形进度；悬停或键盘聚焦时通过产品内 tooltip 显示百分比与 `prompt/context` token 明细，并补齐 `meter` 可访问语义。
- **回归锁定**：Playwright 直接验证双 composer 控件四边计算样式均为 `0px`，并覆盖 Chat / Workspace 圆环无可见数字及悬停详情。
- **验证**：UI typecheck / lint / build 全绿；`composer.spec.ts` = **11 passed**；`npm test` = **343 passed / 1 skipped**；`npm run test:e2e` = **29 passed**。

## 2026-07-13 — macOS 放大工作台安全区

- **根因与修复**：SideDock 放大态以 `position: fixed; inset: 0` 覆盖 Web 标题栏，但共用头部没有继承 macOS 原生 traffic lights 的左侧安全区，文件 / 浏览器等标题会落到原生窗口控件下方。标题栏和放大 SideDock 现统一复用 `--ad-traffic-light-safe-x: 88px`。
- **回归锁定**：Playwright 模拟 Tauri/macOS，打开文件工作台并放大，直接断言标题边界不与 `88px × 46px` traffic-light 区域相交；真实渲染同时检查返回与标题布局。
- **验证**：UI typecheck / lint / build 全绿；`navigation.spec.ts` = **6 passed**；`npm run test:e2e` = **27 passed**。

## 2026-07-13 — 记忆与 Skill 设置层级收口

- **Skills 主次分离**：已启用 / 待审核 / 已归档导航与学习、新建等主操作保留在工具栏；自动学习改为可折叠摘要，常驻展示启用 / 运行 / 上次结果，展开后以响应式网格配置自动检查、工具调用阈值、学习模型和智能合并提案。
- **记忆运行状态降噪**：搜索与“添加”继续作为主任务，向量 / 词法召回和 Additive Provider 收成紧凑状态组；旧版 Skill 迁移审计改为次级面板，无歧义项时折叠并只显示完成摘要，有待判断项时自动展开并突出数量。
- **共享交互与响应式约束**：新增 `ConfigDisclosure` 统一摘要、展开区和 `aria-expanded` 语义；Skills 配置在 1280px 桌面视口无横向溢出，窄屏切成单列，记忆状态组可换行而不挤压搜索。
- **契约保持不变**：Candidate 审批、迁移分类、Provider 开关、learned Skill 反馈 / 快照等交互只调整信息层级，没有改变后端产品契约。
- **验证**：`npm run lint`、`npm run typecheck`、`npm run build` 全绿；`npm test` = **343 passed / 1 skipped**；`npm run test:e2e` = **26 passed**；双轴审查均无残留问题。

## 2026-07-12 — 记忆与 Skill 学习前端闭环

- **记忆管理可见化**：记忆页新增对宿主已注入 Additive Memory Provider 的身份 / 启用状态与开关（不包含接入配置入口），文案明确本地仍是唯一写入真相源；旧 `global.skills` 迁移池以只读审计面板展示 candidate、Agent Note 和 ambiguous 分类。
- **learned Skill 反馈与版本**：Skills 页可记录成功、失败和修正；修正提交完整 `SKILL.md` 时只生成待审核 optimistic-lock patch。原“回滚最新”升级为快照时间线，可预览并选择指定版本回滚。
- **来源与提醒闭环**：Candidate 的来源对话和 evidence 可直接打开对应对话；后台待审核数量和上次学习失败会在主侧栏设置入口及 Skills 设置导航显示全局提醒。
- **回归锁定**：SDK 新增只读迁移池方法和契约测试；Playwright 新增真实 daemon 场景覆盖 Provider / 迁移视图、全局提醒、来源跳转、快照和反馈 patch；真实页面截图验证记忆页布局无溢出。
- **验证**：`npm run lint`、`npm run typecheck`、`npm run build` 全绿；`npm test` = **343 passed / 1 skipped**；`npm run test:e2e` = **26 passed**。

## 2026-07-12 — Core Memory 契约与可审核 Skill 自动学习

- **记忆/程序彻底分离**：active memory 只接受全局 `user-profile/agent-notes` 与工作区三层；derived facts 不进入常驻 manifest。旧 `agent-memory` 迁为 Agent Notes，旧 `global.skills` 进入只读迁移池并分类为 pending Candidate、Agent Note 或 ambiguous；`skills.md` 原件与 legacy backup 均保留。
- **Candidate 审核管线**：新增结构化候选、证据、scope、完整 package、unified diff 与 validation report；校验 frontmatter、Verification、引用/路径/symlink、声明工具、凭证、指令注入、数据外传、不可见 Unicode、package 大小和全 package optimistic hash。批准才原子写入全局或 workspace Skill source并刷新会话；删除最后来源删除所有未批准候选。
- **Learn 与 restricted reviewer**：Chat composer 和 Skills 设置均可把对话、文本、confined path 或 SSRF-safe URL 组成正常 Agent 学习 turn；`stage_skill_candidate` 永不直接激活。后台只读成功 trajectory/catalog，低信号、取消、未恢复失败和 secret-bearing 工作跳过，`Nothing to learn` 为正常结果，失败不影响主答复。
- **反馈与 curator**：learned Skills 在成功加载后记录 use，并记录 view/success/failure/correction/patch；修正可产生全 package 版本绑定 patch candidate。pin、30 天 active→stale→recoverable archive、pre-transition snapshot、可读报告、restore/rollback 已接 API/UI；用户创作和 pinned Skills 不受自动维护，LLM consolidation 默认关闭，开启后以指定/最近聊天模型 dry-run 且只能提案。
- **Additive provider hardening**：本地始终负责所有写入；外部 provider 召回可关闭，失败安全降级，内容限条/限长、扫描 secret/injection、带 provider attribution 与 untrusted fence。Chat/Workspace/IM 复用 SessionHost，直接 `/v1` 继续不带记忆或 Skill 学习。
- **验证**：双轴 code review 最终 **Standards 0 findings / Spec 0 findings**；`npm run lint`、`npm run typecheck`、`npm run build` 全绿；`npm test` = **341 passed / 1 skipped**；`npm run test:e2e` = **25 passed**；设计文档派生 HTML 已同步。

## 2026-07-12 — 来源事实 provenance 与确认提升

- **显式来源 / 生命周期**：记忆条目新增 `origin`（manual / agent-managed / extracted / imported / provider）、`state`（derived / curated）与 `sourceThreadId`；旧库启动时把带 `session_id` 的行迁为来源事实，其余不可可靠区分的既有行安全归为 `imported/curated`。
- **删除与提升闭环**：被动抽取写入 `extracted/derived`；删除来源对话会跨 run/历史提交屏障等待在途工作，级联删除仍由它拥有的 derived facts、消息/FTS 与 cold/live pi 会话状态；JSONL 删除失败会向 API 冒泡。新增 `POST /memory/:id/promote|pin` + SDK/UI「确认并保留」（固定），提升后清除来源关系并保存 promoted audit meta；编辑来源事实或 Agent 明确 replace 也会提升。
- **记忆 UI**：来源徽章不再靠 `sessionId` 猜测，明确显示手动、Agent 管理、自动提取、既有/导入、外部 Provider；来源事实显示来源 thread 摘要和提升操作。
- **验证**：`npm run lint`、`npm run build`、`npm run typecheck`、`npm test` = **314 passed / 1 skipped**；`files-memory.spec.ts` = **3 passed**；设计文档派生 HTML 已同步。

## 2026-07-12 — 默认工作区直达

- **入口语义收口**：首页和侧栏把「打开工作区」改为「新建工作区」；点击后直接创建 daemon 管理的 `workspace/NewProjectN` 默认工作区并进入空白 Workspace，不先弹系统目录选择器或二次确认。
- **显式目录选择**：`ContextBar` 项目菜单的「打开文件夹」独立调用目录选择器；取消后保持当前默认工作区，不创建额外项目。
- **回归锁定**：新增 Playwright 用例覆盖默认工作区创建、空态 composer、默认路径和取消目录选择，UI e2e 总计 **23 条**。
- **验证**：`npm run lint`、`npm run typecheck`、`npm test` = **296 passed / 1 skipped**，`npm run test:e2e` = **23 passed**。

## 2026-07-10 — 自定义 Provider 模型目录与思考继承

- **模型元数据与协议解耦**：自定义模型即使通过不同 API family 接入，运行时也可继承目录模板的名称、推理能力、思考档位映射和输出上限；报文级 `compat` 仅在模板 API 与当前 API 一致时应用，避免跨协议角色/工具消息污染。
- **后端自动匹配**：`compatibilityMode:auto` 在没有 `catalogRef` 时按精确模型 ID 选择唯一或 provider 前缀候选，现有配置无需重新保存即可恢复上述运行时能力；已有 `contextWindow/inputModalities` 不会被运行时覆盖。
- **UI 目录匹配**：模型 ID 自动匹配与手动模板搜索不再被当前 API family 过滤；新匹配或手动选择模板时，UI 会把上下文与模态复制进逐模型配置，并显示继承的推理能力。
- **对话框同步**：`/models.modelSources[].reasoning` 暴露运行时能力；Chat / Workspace 无偏好时推理模型默认 `medium`，显式 `off` 也按 provider-scoped route id 保存。
- **验证**：`npm run lint`、`npm run typecheck`、`npm run build`、`npm test` = **296 passed / 1 skipped**；`composer.spec.ts` = **9 passed**，Playwright UI e2e 总计 **22 条**。

## 2026-07-09 — 联网工具门控与 explore_web

- **工具契约收口**：自定义联网工具从 `web_search` 重命名为 `explore_web`；`query` 模式新增 `max_results`（1–10，默认 5），`url` 模式继续经 SSRF 安全取页并截断正文。
- **真实门控**：修通 `excludeTools` 从聊天 UI → `/agent/run` → `SessionHost` → pi customTools；排除列表加入会话资源缓存键，联网开关变化会重建工具集，不再出现“UI 已关但模型仍可调用”。
- **工作区 composer 对齐**：空态问候与输入框整体垂直居中；审批策略移到 `+` 右侧，模型 / 上下文压力与聊天页一致放到发送按钮左侧。
- **验证**：`npm run lint`、`npm run typecheck`、`npm run build`、`npm test` = **295 passed / 1 skipped**；`composer.spec.ts` = **8 passed**，Playwright UI e2e 总计 **21 条**。

## 2026-07-09 — 本地模型运行参数迁移到模型页

- **采样入口收口**：移除聊天 composer 右侧生成参数浮层与浏览器 `ew.sampling` localStorage；输入框只保留本轮上下文、附件和发送控制。
- **daemon 侧模型默认值**：新增 `LocalModelRuntimeSettings` 契约与 `LocalModelSettingsStore`，以 `models.local.settings` 保存每个本地模型的默认采样参数；`/models/local` 返回 settings，`GET/POST /models/local/settings` 支持读写，删除本地模型时清理相关设置。
- **运行态注入规则**：`SessionHost` 在调用方未显式传 `sampling` 且模型为本地模型时读取默认值；显式 `/agent/run` 或 `/v1` 参数仍优先，工作区、聊天和外部渠道共用同一规则。
- **模型页 UI**：本地文本/视觉模型卡片新增「运行参数」展开面板，支持严谨/均衡/发散预设与 `temperature/top_p/top_k/min_p/repeat_penalty/max_tokens` 单项编辑；嵌入模型不显示采样控制。
- **模型选择分级**：`/models` 新增 `modelSources` 元数据，UI 模型下拉在多个本地 / 云端来源并存时按「本地模型 / provider id」分组，当前按钮也显示来源前缀，避免多模型商平铺混杂；provider 模型内部改用 `provider:<providerId>:<modelId>` route id，`modelSources.modelId` 负责展示/上游映射，避免自定义 provider 与内置 provider 的同名模型互相覆盖。
- **斜杠模型切换分级**：`/model` 参数面板改为先选本地/provider 来源，再在该来源下选模型；同名模型不会在斜杠菜单里混排。
- **验证**：`npm run lint`、`npm run typecheck`、`npm test` = **276 passed / 1 skipped**、`npm run build --workspace @ew/ui`、`git diff --check`；另定向跑过 `npx vitest run packages/core/test/contract.test.ts packages/core/test/local-model-settings.test.ts packages/core/test/sampling.test.ts`。

## 2026-07-09 — Channel Operations + Settings Host 深模块化

- **Channel Operations 应用层**：新增 `packages/core/src/channels/operations.ts`，把 `ChannelGateway`、`ConnectorHost`、connector CRUD/启停、Feishu/WeChat QR setup session、inbox read model 与 `/inbox/events` SSE invalidation 收到同一个 core-side 边界；`routes/channels.ts` 退化为薄 HTTP adapter，`app.ts` 只负责装配与生命周期。
- **生命周期收口**：core stop 会先 abort 未完成的 Feishu/WeChat 扫码 setup session，再统一停止连接器，避免取消/退出后异步成功继续落库或启动 connector。
- **设置页 page-host**：新增 `apps/ui/src/settings/SettingsHost.tsx`，集中 section registry、上次分区持久化、`ew:open-settings` 定向打开、visited keep-alive 与整页覆盖布局；`pages/Settings.tsx` 保留兼容 re-export，`App.tsx` 不再直接持有设置页运行态。
- **验证**：`npx vitest run packages/core/test/im-gateway.test.ts packages/core/test/channel-operations.test.ts`、`npm run typecheck --workspace @ew/core`、`npx playwright test apps/ui/e2e/settings.spec.ts` = **4 passed**、`npm run lint`、`npm run typecheck`、`npm test` = **273 passed / 1 skipped**、`git diff --check`。

## 2026-07-08 — Skills 全局来源分组

- **目录契约对齐 pi**：`/skills` 从裸列表升级为返回 `sources`，每个 Skill 带 `source` 元数据；默认内置目录改为 EasyWork 的 pi agentDir `~/.easywork/pi-agent/skills`，并只额外展示 pi 标准全局目录 `~/.agents/skills`。Codex 兼容目录已移除，项目级 `.pi/skills` / `.agents/skills` 仅运行时按 cwd/trust 生效，不进入全局 Skills 页。
- **运行态一致**：`SessionHost` 的 `DefaultResourceLoader` 使用同一组全局 Skill 目录，避免 UI 可见与 agent 实际加载不一致；`/skills/open` 和模板创建都指向 pi agentDir 下的内置目录。
- **UI 分组**：Skills 页按「内置 Skills / 标准目录」展示，保留空目录分区；顶部不再展示主目录路径。标准目录会显示 `~/.agents/skills` 中每个包含 `SKILL.md` 的目录，辅助 markdown 不单独成 Skill。
- **验证**：`npm run lint`、`npm run typecheck`、`npm test` = **252 passed / 1 skipped**，`npx playwright test apps/ui/e2e/kb-skills.spec.ts` = **2 passed**；desktop 重启后 sidecar daemon 返回 `agents: 20`，Skills 页可见标准目录技能。

## 2026-07-07 — 收件箱 SSE 失效事件

- **实时性模型**：移除 `Inbox.tsx` 的 4 秒固定刷新，改为打开收件箱时通过 `GET /inbox/events` 订阅 Bearer 鉴权 SSE；事件只携带 `ready/changed` 与 reason/thread/channel，消息正文仍从 `/inbox/threads` 和 `/threads/:id/messages` 读取。
- **后端触发点**：`ConnectorHost` 在渠道用户消息与助手回复落库后通知 core；连接器创建、扫码完成、启停、删除也发 `connector/status` 失效事件，收件箱收到后重新读取 read model。
- **测试覆盖**：SDK 覆盖 GET SSE 解析，core 覆盖真实 HTTP `/inbox/events` 长连接与连接器变更推送，ConnectorHost 覆盖消息落库通知。

## 2026-07-07 — macOS 标题栏拖拽区修复

- **根因**：Tauri 自定义标题栏只在外层 `.ad-titlebar` 挂了 `data-tauri-drag-region`，内部 `.ad-tb-seg-*`、任务名、spacer、项目/分支 pill 等实际命中元素没有标记；macOS 三指拖拽落在这些视觉标题栏区域时不能稳定触发窗口拖动。
- **修复**：给标题栏非交互区域及其内部文本 / 图标补齐 `data-tauri-drag-region`；保留侧栏折叠按钮和工作台按钮为普通交互控件，不让点击操作变成拖拽。
- **回归测试**：新增 Playwright e2e 断言标题栏非交互区域都声明为 Tauri 拖拽区，当前 UI e2e 增至 15 条。

## 2026-07-07 — 收件箱聊天优先布局

- **两栏主结构**：收件箱从常驻三栏改为「可调宽会话列表 + 消息时间线」；列表宽度 220–380px 拖拽调整并持久化，中间阅读区成为主视觉。
- **按需详情抽屉**：身份、模型、连接器状态与活动信息从常驻右栏移入右侧抽屉；顶部保留状态 chip、详情按钮和渠道设置按钮。
- **自适应**：中窄屏继续保留两栏和抽屉，窄屏切成上方会话队列 + 下方消息流；详情抽屉改为页面内覆盖层。

## 2026-07-07 — 收件箱可读性优化

- **信息层次**：收件箱不再把 opaque channel id 当主标题展示，微信 / Telegram 等渠道会 fallback 为「微信联系人」这类友好称呼，完整 ID 仅保留在副标题和 tooltip。
- **消息阅读**：会话预览清洗 Markdown 标记，助手消息气泡改为 Markdown 渲染；布局优先保证中间阅读区。
- **状态语义**：顶部状态与右侧详情统一为「自动回复中 / 已停止 / 未启用 / 未配置」，底部输入区改成只读提示，避免暗示手动回复已可用。

## 2026-07-07 — 外部渠道收件箱 A 版

- **Inbox 读模型**：core 新增 `GET /inbox/threads`，从现有 `ConversationRepo` channel threads 聚合外部渠道会话、最后一条文本预览和消息数；SDK 新增 `listInboxThreads()`，`threadMessages()` 类型对齐真实 `StoredMessage[]`。
- **首版三栏 UI**：`apps/ui/src/pages/Inbox.tsx` 按 A 版落地「渠道会话队列 / 消息时间线 / 身份与连接器状态」；支持搜索、运行中/未运行筛选、刷新、空态直达渠道设置。首版保持只读，手动回复与暂停自动回复保留为后续真实控制点。
- **导航收口**：侧栏普通「对话」和全局搜索不再混入 channel threads，外部消息集中进入收件箱；详情栏按同类 connector status 显示运行状态。
- **验证**：新增 `/inbox/threads` core route 测试与 SDK route 测试；`npm run lint`、`npm run typecheck`、`npm test` = **233 passed / 1 skipped**、`npm run test:e2e` = **14 passed**、`git diff --check` 均通过；真实浏览器连接重启后的 daemon，收件箱 route 200 且微信渠道线程可见。

## 2026-07-07 — WeChat iLink 便捷连接（对齐 Hermes）

- **个人微信路线校正**：对齐 Hermes Agent 的 Weixin 方案，采用腾讯 iLink Bot API，而不是 Web 微信逆向；扫码得到的是 iLink bot 身份，默认以私聊文本收发为主，普通群聊是否投递事件取决于腾讯侧，因此群聊策略默认 `disabled`。
- **扫码注册 helper**：core 新增 `POST/GET/DELETE /im/wechat/register` 管理路由，前端可直接展示微信扫码二维码；扫码确认后自动保存 `accountId/token/baseUrl` 的 WeChat 连接器，取消或 core stop 会 abort 未完成注册。
- **adapter 运行态**：`WechatChannelAdapter` 通过 `getupdates` long-poll 接收入站文本，保存 `get_updates_buf` sync cursor；回复走 `sendmessage`，带上 peer 最新 `context_token`，并在 stale session 时删除 token 后重试一次。首版为 text-only，媒体/CDN 加密链路后续再补。
- **设置页体验**：渠道页新增 WeChat 扫码连接面板；高级配置保留已有 iLink token 手动接入、`accountId/baseUrl/groupPolicy/groupAllowlist`。
- **验证**：新增 iLink QR 注册、long-poll 入站、context token 出站、core 注册路由与 SDK 路由测试；`npm run lint`、`npm run typecheck`、`npm test` = **232 passed / 1 skipped**、`npm run test:e2e` = **14 passed** 通过；`git diff --check` 通过。

## 2026-07-06 — Feishu webhook 安全收口 + lint 清零

- **Webhook 边界收紧**：Feishu/Lark 默认 WebSocket 连接器不再接受 `/im/:id/webhook`；高级 webhook 模式必须配置 `verificationToken` 或 `encryptKey`，否则拒绝 public webhook，避免 bearer-exempt 入口被误当内部调用面。
- **raw body 限制**：core 为平台签名捕获 webhook raw body 时，在 `Content-Length` 与流式读取中执行 32MiB 上限，避免未授权大请求先被完整缓冲。
- **扫码取消一致性**：`DELETE /im/feishu/register/:id` 和 core stop 都会 abort 未完成扫码注册；即使 SDK 后续成功返回，也不会继续 upsert/start 连接器。
- **lint 清理**：清掉历史 `no-explicit-any` 与未使用状态 warning，`npm run lint` 当前无 warning / error。
- **验证**：`npm test` = **229 passed / 1 skipped**；`npm run typecheck` 通过；相关 Feishu/security 定向 vitest 通过；`git diff --check` 通过。

## 2026-07-04 — Feishu / Lark 便捷连接

- **WebSocket 默认传输**：`FeishuChannelAdapter` 接入官方 `@larksuiteoapi/node-sdk` 的 `createLarkChannel`，默认用出站 WebSocket 长连接接收 `im.message.receive_v1`，无需公网 webhook；高级模式仍可显式配置 `transport:webhook`。
- **扫码注册 helper**：core 新增 `POST/GET/DELETE /im/feishu/register` 管理路由，启动 SDK `registerApp` 扫码创建/授权应用；扫码成功后自动保存 `transport:websocket` 的 Feishu/Lark 连接器并按配置启动。
- **设置页体验**：Feishu/Lark 默认展示“扫码连接”面板、飞书/Lark 区域切换、二维码和注册状态；App ID / App Secret / webhook 参数折叠到“已有应用 / 高级配置”。
- **验证**：新增 WebSocket fake channel 入站/出站测试、扫码注册路由测试与 SDK 路由测试；当时全量 vitest/typecheck 通过，Playwright UI e2e **14 passed**；当前测试总数见上方最新里程碑。

## 2026-07-04 — Feishu / Lark webhook adapter

- **Feishu adapter**：新增 `FeishuChannelAdapter` 与 registry entry，支持自建应用 URL verification、Verification Token、`X-Lark-Signature`、Encrypt Key 加密回调解密、`im.message.receive_v1` 文本事件归一化，以及 `tenant_access_token` + `im/v1/messages` 文本回复。
- **Core webhook**：`/im/:id/webhook` 保持免 EasyWork Bearer，由 adapter 校验平台签名；core 仅针对 webhook 捕获 raw body 后传入 `WebhookRequest.rawBody`，避免签名校验依赖重新序列化 JSON。
- **UI**：渠道设置页按 adapter metadata 同时渲染必需 / 可选密钥；Feishu/Lark 表单补 `baseUrl` 和 `receive_id_type` 选项，平台从 `/im/adapters` 自动露出。
- **验证**：新增 Feishu URL verification、token/signature、加密 payload、文本消息归一化、文本回复 API 测试，以及 core 签名 webhook 路由测试；`npm test` = **224 passed / 1 skipped**，全量 typecheck 通过，Playwright UI e2e **14 passed**。

## 2026-06-30 — Channel Gateway 抽象层落地

- **抽象层**：`@ew/shared` 扩展 `ChannelConfig/ChannelStatus/ChannelTarget/ChannelAdapterMeta/InboundMessage` 等契约；`@ew/im-connectors` 新增 `ChannelAdapter`、`ChannelAdapterRegistry`、`ChannelGateway`，把平台生命周期、状态、allowlist、webhook 和出站 target 统一收口。
- **Telegram 迁移**：保留旧 `TelegramConnector` 兼容测试，同时新增 `TelegramChannelAdapter` + `telegramAdapterEntry`，作为第一个内置 adapter。后续 Feishu/Lark、Discord gateway、WeCom callback 都注册进同一个 registry。
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
- **斜杠命令面板升级**：`SlashPalette.tsx` 改成两阶段 command palette 风格——头部显示当前阶段，列表右侧展示当前值 / 当前项，`/model` 先选来源再选模型，`/compact` 会带上当前上下文占比。`lib/slash.ts` 也补上 `THINK_META`，把文案与运行态标签统一起来。
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
- **斜杠命令**：`lib/slash.ts` + `useSlashPalette`（两 composer 共用）——输入「/」两阶段自动补全：`/think <档位>`、`/model` 来源→模型、`/compact`。
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
- **思考 / explore_web 统一为工具卡**：reasoning→`THINK` 卡、explore_web→`SEARCH` 卡，与 READ/EDIT/RUN 同套 `cv-tool` 折叠卡（图标 + mono 大写标签 + 状态 pill + chevron + 折叠体）。
- **消息样式**：用户消息改强调色实心气泡（去头像，`You` + 时间戳右对齐），助手名 → `AI assistant`；UiMsg 加 `at`。
- **上下文用量进度环**：composer 内 `ContextRing`（已用占比，越界变琥珀/红），替代 header 横条。修 bug：切换会话漏重置 `usage` → 进度环串号；现切换即清空。打开历史长会话回填用量：`SessionHost.lastUsage` 读 pi 会话日志最后一条 assistant 的 usage，端点 `GET /threads/:id/usage` + SDK `threadUsage`。口径修正：`promptTokens = input + cacheRead + cacheWrite`（prompt cache 活跃时只取 input 会严重低估），实时映射与历史回填统一。
- **网页内联预览修 bug**（并入工作台坞「预览」tab）：Tauri webview 里 `target=_blank` 会把整个 app 导航走且回不来；`MessageStream` 统一拦截来源 chip + markdown 外链 → 右侧预览。
- **上下文窗口确定/配置**：① 本地加载默认用模型**原生最大上下文**（GGUF `context_length`，去掉 8192 封顶；Qwen3-4B 同份 ~2580 token 系统提示词占比 31%→~8%）。② 云端 provider 新增**手动上下文窗口**（`CloudProviderConfig.contextWindow`：表单输入 → 持久化 → pi compaction 阈值 + `/models` context 映射 + 进度环），缺省 32768。
  - 诊断点：对话区「31% 占比」来自每轮固定 preamble（pi coding-agent 系统提示词 + 全部工具 schema + 记忆清单 ~2580 token），非用户输入；对话模式也加载完整编码工具集。
- 杂项：去标题栏装饰性假交通灯点；`spike-session.mjs` 空 catch 补注释（`no-empty`，lint 归零 error）。
- 验证：shared/sdk/core 重建、ui tsc/eslint/build、全量 **212 测试**全绿；exec/reveal/usage/providers 真机 curl 往返（含测试 provider 加删清理）+ Playwright 视觉核对（工具卡统一、用户气泡、进度环、放大铺窗、来源点击预览）。

## 2026-06-21（续）— 统一右侧「工作台坞」+ 网页内联预览 + 交互式终端

把对话区与工作区右侧三套各自为政的抽屉（工件面板 / 网页预览 / 工作区 Diff·Files·Terminal）合并为**一个共享的 `SideDock`**，并按使用反馈补三项能力。后端仅新增 exec/reveal 两类端点，其余纯前端。

- **网页内联预览（修 bug）**：Tauri webview 里点 explore_web 来源 / 消息内 markdown 链接的 `target=_blank` 会把整个 app 导航走且回不来。改为 `MessageStream` 统一拦截 → 右侧预览（`onOpenUrl`），来源 chip 由 `<a>` 改 `<button>`、markdown 链接自定义 `a` 渲染；`referrerPolicy=no-referrer` + sandbox iframe，禁内嵌站点退化为「复制链接」。
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

## 初始阶段总览（2026-06-13 历史快照）

> 下列勾选保留项目起步时的路线记录，不代表当前架构；后续里程碑已用 pi AgentSession、llama router 与 Tauri 取代其中的 engine-worker、自研 agent loop 和 Electron。

- [x] **阶段 0 — 地基**：CLAUDE.md、monorepo 骨架、`@ew/shared`、`@ew/engine-worker`、`@ew/core`+`@ew/sdk`+`@ew/daemon` 端到端贯通 ✅
- [x] **阶段 A — 模型运行**：EngineRegistry、local-llamacpp / openai-compatible provider、ModelManager（HF 搜索/下载/扫描）、`/v1` 端点 ✅
- [x] **阶段 B — Agent 工具**：自愈解析器、ToolRegistry/ApprovalGate、agent loop controller、MCP client、Skills runtime ✅
- [x] **阶段 C — IM + 记忆**：MemoryProvider（本地分层 markdown + 向量/词法召回）+ Mem0 骨架、ConversationRepo、ChannelConnector + Host + Telegram + Feishu/Lark + WeChat iLink ✅（Discord/WeCom 待补）
- [x] **阶段 D — 桌面 + UI**：Electron supervisor、React UI（Chat/模型/设置）、electron-builder 配置 ✅（GUI 未在本环境可视化验证；连接器 Discord/WeCom 待补）

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
- **Web 搜索工具**（`@ew/tools` `explore_web`，仿 Unsloth：`query` 搜 DuckDuckGo / `url` 取页正文）。直测返回真实结果（标题+URL+摘要）。
- **工具开关门控**：`/agent/run` 加 `excludeTools`；UI 的「联网」关 → 排除 `explore_web`/`http_get`（开则提供给模型）。runAgent 据此过滤工具集。
- **Think 模式**：「思考」开关经 `think` 标志传给 daemon，注入 `/think`//`no_think` 给模型（Qwen3）——**不污染持久化的用户消息/会话标题**（之前直接拼进 content 导致标题带 /think，已修）。
- **Token 用量**：引擎 `usage` 事件经 agent loop 转成 `AgentEvent.usage`，聊天头显示 `↑prompt ↓completion`。
- **思考耗时**：检测 `</think>` 计算时长，思考块显示「思考了 N 秒」。
- Playwright 真机验证：思考了 2 秒、token ↑283↓276、联网工具可用、会话标题干净、borderless markdown。63 测试/build/typecheck/lint 全绿。

### 2026-06-13（续）— Web 来源 chips / 侧栏折叠 / 上下文进度条
- **Web 搜索来源 chips**（仿 Unsloth "Used tool: Searched…" + 来源 chips）：`explore_web` 的 `ToolResult.display` 携带 `{title,url}[]` → 经 AgentEvent 流到 UI；助手消息里渲染「🌐 已搜索 "query"」+ 来源 chips（favicon via google s2 + 标题，点击新窗口打开）。
- **侧栏折叠**：标题栏 PanelIcon 切换；收起为 64px 图标栏（logo/新对话/导航/profile 仅图标，隐藏标签与历史）。
- **上下文用量进度条**：`LocalServerManager.contexts()` 暴露每模型上下文长度 → `/models.context` → UI 头部显示 `promptTokens / maxContext`（如 284 / 4.1k）+ 蓝色进度条。UI 加载模型时按 GGUF `contextDefault`（封顶 8192）传 contextSize。
- Playwright 真机验证：来源 chips（favicon 正常加载）、折叠图标栏、上下文条「284 / 4.1k」均正确。63 测试/build/typecheck/lint 全绿。

### 2026-06-14 — 对照 Unsloth Studio 的推理侧能力补齐（一轮系统性 parity）
逐项对比参考实现后，按优先级修复（每项带单测，全程 build/typecheck/lint/vitest 绿）：
- **配置持久化**：provider 列表 + MCP server 配置落 SQLite `settings` 表，daemon 重启后恢复（此前仅内存，重启即丢）。
- **采样参数补齐**：`ChatRequest` 新增 `topK/minP/repeatPenalty/frequencyPenalty/presencePenalty/reasoningEffort`，openai-compatible 透传（`top_k/min_p/repeat_penalty` 走 llama-server 扩展字段）；`/agent/run` 与 `/v1` 均接受。
- **SSRF 防护**：`http_get`/`explore_web` 取页改用 `safeFetch`——拒私网/环回/链路本地/云元数据地址，DNS 解析校验，重定向逐跳重校验。
- **模型 LRU**：`LocalServerManager` 加最大常驻数（`EW_MAX_LOADED_MODELS`；历史版本默认值较低，当前 `RouterServerManager` 默认 4）+ 使用即触碰的 LRU 淘汰，防 OOM。
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
- **仍未做**：python/terminal 代码执行沙箱（Unsloth 有；安全敏感、默认关，留作专门设计）；IM 连接器 Discord/WeCom（**非 Unsloth 功能**，属 EasyWork 自身路线，需实盘凭证联调）。

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
- 个人微信走腾讯 iLink Bot API 的 bot 身份（扫码登录 + long-poll）；不要回到 Web 微信逆向。企业微信仍走后续 WeCom adapter。
