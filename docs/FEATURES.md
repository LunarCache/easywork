# EasyWork · 功能与设计

> 功能详解。概览见 [README](../README.md)；架构 / 技术栈 / 环境变量见 [ARCHITECTURE](ARCHITECTURE.md)；进度见 [PROGRESS](PROGRESS.md)；开发约定见 [AGENTS.md](../AGENTS.md)。

## 模型

- **本地**：从 HuggingFace 搜索、下载（断点续传）GGUF；默认使用官方源，国内网络可在**设置 → 通用**持久化启用 `hf-mirror.com`，模型搜索、变体查询、普通模型下载和记忆 embedding 下载统一切换，搜索失败会直接显示错误与镜像提示。模型经统一 `llama` 的 **router 模式**运行 —— 单个 `llama serve --models-dir` 进程按请求 `model`（= 模型子目录名）路由、按需 auto-load、`--models-max` LRU 淘汰（文本 / 视觉）。router 不额外传 `-c`；UI / 上下文压力优先读取 GGUF `context_length`，元数据缺失时 SessionHost 当前按 8192 兜底。记忆嵌入模型走**独立**的 `llama serve -m --embedding` 进程，与 router 分离：启动时只会恢复已持久化且仍存在的模型路径，或启用已下载到默认路径的 nomic 模型（缺失则记忆降级纯词法，不崩）；也可在**设置 →「记忆」页的紧凑运行状态组**一键下载 nomic-embed 并重建索引，状态同步显示在**模型页**（嵌入卡「运行中 / 已启用」）。
- **云端**：同时支持 pi-ai 内置 provider 与自定义兼容端点。「模型 → 云端 API」按服务商卡片进入配置；自定义端点可保存多组 OpenAI Chat/Responses、Anthropic Messages、Google Generative AI 等 API family + Base URL 连接方式，未分配模型的新连接也会持久化，并可通过标准 `/models` 接口获取模型列表（失败时仍可手动添加）。每个模型独立选择连接方式并保存 ID、上下文窗口、文本/视觉模态、推理能力覆盖和目录模板引用，因此同一聚合服务商中的 OpenAI 模型和 Anthropic-only 模型无需拆成两个 provider。
- **目录模板与身份**：Core 的 Provider Model Configuration 从保存配置统一产出 scoped route、上游 model id、有效 API / Base URL、最终 runtime model 与列表投影；模型覆盖优先于 provider 默认值。UI 的自动匹配 / 手动选择只编辑和展示保存投影。运行时可跨 API family 继承名称、`reasoning`、`thinkingLevelMap` 与输出上限；Anthropic Messages 的用户态 Base URL 可保留 `/v1` 或完整 `/v1/messages`，Core 传给会自动追加 `/v1/messages` 的 SDK 前会转换为根地址，界面预览即真实请求地址。上下文窗口和输入模态由 UI 在匹配 / 选择模板时复制进逐模型配置，不会在运行时覆盖已有值；`compat` 属于报文协议，只在模板 API 与有效模型 API 一致时应用，未知自定义 OpenAI-compatible 端点默认采用不发送 developer role 等保守能力。逻辑 route id 为 `provider:<providerId>:<modelId>`（两段实际会 URL 编码），因此自定义与内置 provider 的同名模型不会互相覆盖；旧线程或外部客户端传入裸模型名时仍保留兼容解析。缺失 pi 目录的 `pi-native` 模型可继续被列出 / 删除，但实际运行 fail-closed，不会降级成错误协议。

## Agent 内核 = pi-coding-agent（托管）

- 内核为托管 [`@earendil-works/pi`](https://github.com/earendil-works/pi) 的 `AgentSession`（无头嵌入）：自带编码工具（read/bash/edit/write/grep/ls/find）、自动上下文 compaction、会话管理。EasyWork 是它的宿主 / 集成层。
- **真实工具审批流（4 档）**：`read-only` / `approve-each` / `auto-edits` / `full-auto`，经 pi `tool_call` 钩子映射；危险工具经 SSE 挂起，UI 在**对话栏上方弹出审批卡**（内嵌、非遮罩弹层；简洁单头行 = 盾牌 + 工具名 accent 胶囊 + 右侧紧凑按钮，下方单行参数预览〔命令/路径/紧凑 JSON，悬停看全〕，Chat/Workspace 共用 `ApprovalCard`）「允许 / 总是允许 / 拒绝」。
- **Agent Turn 客户端生命周期**：Chat 与 Workspace 共用 `AgentTurnController`，由它统一发送 / 重试 / 编辑重试 / 停止、审批、SSE 事件消费、用量、瞬态提示、工件、错误和完成；页面只提供请求、审批档位同步和工具完成后的刷新 policy。
- **工作区路径限定**：fs 工具路径经 realpath 解析后硬拦越界（含软链接），bash 由审批把守。
- **内置工具**（桥成 pi customTool）：`get_time` / `calculator` / `http_get`（带 SSRF 防护）/ `explore_web`（DuckDuckGo 摘要搜索 + 安全取页，`max_results` 可设 1–10，默认 5）。聊天页关闭联网时会从 pi customTools 中同时移除 `explore_web` / `http_get`，工具集变化会触发会话资源重建。
- **记忆 / 会话检索**：记忆经 pi 扩展接入——**渐进式披露**（记忆「清单」注入系统提示词 + `recall_memory` 工具按需取全文，借鉴 Skill）+ **批量事实抽取**（空闲 / 关闭时，非每轮）。每条记忆显式记录 `origin/state/sourceThreadId`：被动抽取是由来源对话拥有的 Extracted Fact；Source Conversation 生命周期在同一 run / delete 屏障内删除其事实、候选证据、消息 / FTS 与 pi 会话状态，并只尽力清理 EasyWork 管理的 scratch 工件，永不删除用户工作区目录。用户可在记忆页「确认并保留」（固定）为独立 Curated Fact，编辑来源事实也会先提升。会话检索通过 customTool 接入。外部 Provider 目前只能由宿主注入，Desktop / CLI 没有配置入口；未注入时记忆页不显示空状态，注入后才显示启停状态。
- **MCP**：stdio（默认禁用，需开关）+ HTTP；工具桥成 pi customTools；导入标准 `mcpServers` JSON；连接探测（带超时）+ 工具清单预览 + 编辑已有配置（保留 OAuth / env）+ 探测失败错误详情；`callTool` 透传中断信号。
- **Skills**：pi 自带 skills（resourceLoader 发现）+ 应用内 Skills 管理；`SkillCandidateLifecycle` 是候选 / 审核 / Learned Skill 状态迁移的唯一入口，routes、Agent tool、后台 reviewer 与启动迁移都不能直接访问 candidate store。管理页用“已启用 / 待审核 / 已归档”分开主流程，只展示全局来源，并按内置主目录 `~/.easywork/pi-agent/skills` 与标准目录 `~/.agents/skills` 分组，项目级 skills 仅在运行时按 cwd 生效。自动学习以可折叠摘要显示开关、运行态与上次结果；展开后按响应式网格配置自动检查、工具调用阈值、学习模型和智能合并提案，在 1280px 桌面宽度下不产生横向溢出。learned Skill 可在页面记录成功 / 失败 / 修正反馈；修正只生成待审核 patch。版本入口展示可选快照时间线并回滚到指定版本，Candidate 的来源对话和证据可直接跳回原对话。

## 工作区模式

在本地项目目录里读写文件 / 跑命令（git 改动审阅面板）。聊天模式也能写文件 / 跑命令，但**限定在每会话工件目录内**。两种模式共用右侧常驻「工作台」面板（见下方桌面 UI）；Workbench View Session 统一工作台视图打开 / 激活 / 关闭回退与文件、URL 导航，SideDock 只渲染状态。Desktop 真终端从工作台独立出来：标题栏右端在工作台按钮左侧提供终端入口，点击后在对话区底部打开；Terminal Panel Session 单独负责 PTY 恢复、多会话、关闭回退和前台任务确认。

## 外部渠道连接器

`@ew/im-connectors` 已从单个 Telegram 连接器升级为 **Channel Gateway**：平台 adapter registry + 连接器配置/状态 + allowlist + webhook 分发 + 统一回复 target；`@ew/core` 进程内的 `ChannelOperations` 把 gateway/host、连接器生命周期、Feishu/WeChat 扫码 setup session、收件箱 read model 与 SSE invalidation 收成一个应用层边界。当前内置 Telegram（Bot API long-poll，回复按 IM 能力聚合发送，停止可取消正在进行的轮询）、Feishu / Lark（默认走官方 SDK WebSocket 长连接，无需公网 webhook；设置页支持扫码创建应用并自动保存连接器；高级模式仍支持自建应用 webhook、URL verification、Verification Token、`X-Lark-Signature`、加密回调解密、文本消息归一化与文本回复）与 WeChat（对齐 Hermes 的腾讯 iLink Bot API：扫码登录个人微信 bot 身份、long-poll 收消息、文本回复携带 `context_token`、sync/context token 本地持久化）。Discord / 企业微信（WeCom）按同一 adapter seam 补齐。入站消息统一归一为 `InboundMessage`，经 `ConnectorHost` 映射到稳定 thread 后复用同一个 `SessionHost.run`，所以外部渠道与桌面 agent 共享 SessionHost、记忆和工具；`/v1` 客户端不进入 AgentSession，只共享同一 daemon 的模型 router、provider runtime 与鉴权边界。收件箱是基于 channel thread/message history 的只读聚合视图：`GET /inbox/threads` 返回外部渠道线程、最后一条消息预览和消息数，`GET /inbox/events` 通过 SSE 推送 read model 失效事件；前端按聊天优先的两栏结构展示会话队列 / 时间线，收到事件后重新读取列表或当前消息，连接器状态与身份信息进入按需右侧抽屉，不另建消息真相源。渠道 secret 由 core 的 `ChannelSecretStore` 保存：macOS Keychain、Linux Secret Service、Windows 当前用户 DPAPI；SQLite 只保留非敏感配置，已配置字段名由 API read view 动态返回。旧明文配置启动时自动迁移，读取 API 不回显 secret，设置页用“已安全保存，留空保持”完成无明文编辑。渠道管理 API 走 EasyWork Bearer；平台 webhook 入口不要求内部 Bearer，由 adapter 做平台签名/secret 校验，core 只为签名校验捕获 32MiB 内的 raw body。Feishu / Lark 的 public webhook 仅在 `transport:webhook` 且配置了 `verificationToken` 或 `encryptKey` 时启用；默认 WebSocket 连接器不会接受 webhook。WeChat 不是 Web 微信逆向普通号，而是 iLink bot 身份，群聊事件是否可用取决于腾讯侧投递，EasyWork 默认关闭群聊。设置页只显示 registry 已注册 adapter，并按 adapter metadata 渲染必需 / 可选密钥。

## 记忆与自动学习

**Core Memory** 只包含全局 `user-profile / agent-notes`，工作区私有池只包含 `conventions / decisions / pitfalls`。自动抽取的事实先进入带 `sourceThreadId` 的 derived pool；删除来源对话会删除仍由它拥有的事实，用户确认、固定或编辑后才提升为独立 Curated Fact。常驻 manifest 只注入每层最多 12 条 curated 要点，derived pool 经 `recall_memory` 按需加载。全局 `user-profile.md / agent-notes.md` 可手改回灌，工作区为 DB-only；sqlite-vec 不可用时降级词法。

旧 `agent-memory` 启动时迁到 Agent Notes；旧 memory-layer `skills` 不再参与召回，程序化内容转为待审核 Skill Candidate，事实转为 Agent Note，歧义项保留在只读迁移池；原 `skills.md` 保留并生成一次性 `skills.legacy-backup.md`。记忆设置页把这个只读迁移审计池放进次级面板：没有歧义项时折叠并只显示完成摘要；存在歧义项时自动展开、突出待判断数量，并展示每项分类。宿主可选注入的 Deep Memory provider 只能追加受限召回：本地仍是唯一写入真相源，provider 失败、禁用或移除不影响 Core Memory；外部内容进入模型前会扫描、限长、标注来源并以不可信数据围栏隔离。当前 Mem0 适配器仍是骨架，产品没有接入表单；向量召回常驻紧凑状态组，外部 Provider 只在已注入时并排显示状态 / 开关，搜索与“添加”继续作为主操作。

Chat 通过 `/learn` 从当前对话准备 Skill 学习提示，composer 不再单独放置学习图标；Skills 设置仍提供文本、受工作区限制的文件或经 SSRF 防护的 URL 等入口。所有输入都先组成普通 Agent turn，并只能调用 `stage_skill_candidate` 暂存候选。后台学习只读成功轨迹和 Skill 目录，`Nothing to learn` 是正常结果，且没有 shell、文件写入、网络、MCP、消息或委派能力。所有自动候选必须在 Skills 页查看证据、完整 `SKILL.md`、验证报告和 scope 后明确批准；批准才原子激活并刷新 AgentSession。learned Skills 记录使用/成功/失败/修正/patch，支持乐观锁 patch、固定、stale、可恢复归档、快照和回滚；LLM consolidation 默认关闭且也只能产生待审核 diff。后台产生待审核候选或上次检查失败时，侧栏设置入口与 Skills 导航显示全局提醒。

## 采样参数

采样支持按入口区分：本地模型页维护 `temperature / top_p / top_k / min_p / repeat_penalty / max_tokens` 六项默认值，保存到 daemon 侧 SQLite，聊天、工作区和外部渠道共用；单次 `/agent/run.sampling` 显式值优先，其中 `temperature/top_p/max_tokens/seed/frequency_penalty/presence_penalty` 为通用注入，`top_k/min_p/repeat_penalty` 仅注入本地 llama 请求。思考强度走独立的 `thinkingLevel`，不把 `reasoning_effort` 当作通用采样透传。`/v1` 命中本地模型时原样代理请求体；`/v1` 的云端 pi 分支目前只把 `temperature/max_tokens` 作为调用选项传入。

## 思维链

`<think>` 与 gpt-oss harmony 多通道（analysis → 思考 / final → 正文）解析；**思考过程持久化**（作为 reasoning 片段落库），切换 / 重载会话仍可展开回放（不回喂模型）。

## 本地端口暴露

router（`llama serve`）默认仅绑 `127.0.0.1`；可在「设置 → 模型 → 暴露到局域网」切到 `0.0.0.0` 让局域网其他服务直连（**强制设置 api-key**，未鉴权拒绝；切换会重启 router 立即生效）。

## 桌面 UI（"Agent Tasks"）

IDE / 终端味设计语言（IBM Plex Sans / JetBrains Mono · 统一图标描边 1.8 · **默认冷灰浅色 + 可选黑灰深色 + 跟随系统**，明暗统一青绿色强调色，挂 `<html>` data-theme）。

- **Ewo 品牌形象**：冷灰 / 白色机器人头像作为 Desktop 应用图标，深色面屏保留青绿色 `E`、白色命令箭头与星芒天线；同源全身 Ewo 出现在 Chat / Workspace 空状态。平台 SVG / PNG / ICNS / ICO 资源统一生成，图标变化会触发 Rust 构建重跑。
- **外壳**：两段式标题栏（段 A = 实时侧栏宽 + macOS 原生红绿灯 + 侧栏开关；段 B = 面包屑〔任务名 + 工作区 / 分支 pill〕+ 工作台开关〔动态图标，开/关不同〕）+ 展开式侧栏 + 可拖拽对话区 + 右侧常驻工作台面板。主侧栏 / 工作台拖拽线贯穿整个窗口（含标题栏），收件箱内部拖拽线贯穿内容区；热区覆盖边框而不额外制造布局间隔，并支持方向键调宽。
- **展开式侧栏**：顶部快捷操作（新对话 ⌘N / **搜索 ⌘K** / 新建工作区 / 收件箱）+「项目」分区（工作区折叠组，CWD 角标 / hover 新建会话 ＋ / 文件树 / 删除；分区头「折叠全部」）+「对话」分区（独立聊天，带相对时间）+ 底部设置 + 连接状态点。首页和侧栏的「新建工作区」会直接进入一个位于 EasyWork 数据目录下的 `NewProjectN` 默认空白工作区，不先弹目录选择器；只有工作区项目菜单里的「打开文件夹」才显式选择已有本地目录，取消选择会保留当前默认工作区。渠道线程从普通对话列表与全局搜索结果中分离，集中进入**收件箱**（可调宽会话列表 / 消息时间线 / 按需身份与连接器状态抽屉）；顶层标题栏是唯一“收件箱”标题，列表头只保留“外部渠道”与紧凑刷新动作，渠道头像统一使用 `BrandIcon`；展示层隐藏冗长 opaque ID、清洗预览里的 Markdown 语法并渲染助手 Markdown 回复，优先保证外部消息阅读。**全局搜索（⌘K）**：居中浮层跨 对话 / 工作区 / 工作区会话 模糊匹配，↑↓ 选 / Enter 跳转 / Esc 关。
- **对话区**：用户 `acc-weak` 软气泡右对齐 / AI 无头像纯 prose 左对齐；**行内工具调用**（Codex Flat 风：扁平左竖线、过去式步骤、零卡片零暗井，默认折叠、运行中展开）——连续只读勘探（读 / 搜 / 列 / 找）**聚合成「探索 · N」组**；**思考**左竖线 accent；**编辑**〔过去式「已编辑」+ 文件类型徽标 + 文件名(亮)/目录(灰) + `+/-`〕展开为**语法高亮 diff**（复用 `.hljs-*` 着色 + 双栏行号〔解析 `@@`〕 + 改动行红/绿竖条）；**运行**〔`SquareTerminal` 图标 + 过去式「已执行」+ 折叠态命令预览〕展开为浅底圆角卡（`$ 完整命令`悬挂缩进换行 + 灰输出，同卡）。**工作日志**：本轮全部过程（思考 + 工具）包进默认折叠的「已工作 N 分」容器（运行中展开看进度，结束折叠），**只把最终答复留在容器外**；助手回答下方带**时间戳** + **文件改动汇总卡**（工作区默认折叠、点击跳转查看 diff）+ **「本轮交付」卡**（普通对话逐轮持久化最终新增/修改文件；HTML 直接进入右侧浏览器，其余进入文件详情）+ 流式 / 引用 / 图片多模态 / 审批。**滚动到底浮钮**（上滚离底才现，自动滚动仅在底部附近跟随；按钮锚定在 composer 右上方）。
- **工作台与终端**（对话区与工作区共用）：右侧工作台初次打开保持**无标签空态**，正文以左对齐动作列提供新任务、浏览器与 Desktop 终端入口，不再伪造默认“文件”标签；已打开的**改动〔工作区〕/ 文件 / 浏览器**标签、`+`、放大与抽屉按钮直接位于应用标题栏同一行，抽屉内部不再重复工具栏。每个标签可关闭，关闭最后一个标签会回到空态；文件卡 / 消息链接仍会自动打开对应标签。浏览器只接受裸域名或完整 http(s) URL：Desktop 远程页面由 Tauri 原生子 WebView 承载，避开 `frame-ancestors` / `X-Frame-Options` 对 iframe 的限制，并随工作台拖拽、放大、隐藏和关闭同步边界；该远程 WebView 不获得 Tauri IPC capability。Web 运行时回退 sandbox iframe，HTML 文件继续用受控 `srcDoc` 打开。Desktop 真终端使用独立标题栏按钮，在工作台开关左侧；空态终端入口同样只切换这块独立面板，点击后于对话列底部打开，不占用右侧工作台。Tauri Rust + `portable-pty` + xterm 支持多个 shell 会话，工作区从项目根目录启动、对话从会话工件目录启动；隐藏面板、切换任务和 WebView reload 不结束当前 Desktop runtime 的会话，关闭终端标签才结束 PTY，检测到前台任务时先确认。终端背景与前景跟随应用主题；浏览器版不显示终端入口，Agent `bash` 仍只出现在工作日志中。
- **统一文件预览**（`FileViewer` 组件 + `/files/meta`·`/files/raw` 端点）：一个组件按类型渲染——**图片**（鉴权 blob）/ **PDF**（浏览器原生）/ **Markdown**（渲染 ⇆ 源码）/ **SVG**（渲染 ⇆ 源码）/ **代码 · 文本**（highlight.js 语法高亮）/ 二进制兜底下载；项目文件页仍可兼容 HTML 渲染，而 SideDock 中的 HTML 统一交给浏览器标签。
- **composer**：textarea + **顶部活动上下文条** + 底栏动作，输入卡内及其上下文条的 pill / 模型 / 审批 / 附件控件统一无边框，以背景和文字层级区分状态。聊天页顶部条显示 **思考 / 联网**，**模型 / 上下文压力**位于底栏发送按钮左侧，便于发送前确认；上下文压力默认只显示环形进度，不铺数字，悬停或键盘聚焦时才显示百分比与 token 明细。模型下拉在存在多个本地 / 云端来源时按**模型商 / 本地模型**分组。工作区顶部条保留 **项目 / 分支 / 思考**；底栏统一为左侧 `+` → **审批策略** → 附件状态，右侧 **模型 / 上下文压力 / 发送或停止**。模型采样不再放在输入框内，改到模型页按本地模型配置。瞬态提示仅在重试 / 压缩等 notice 出现时显示。
- **工作区上下文条 + 空态居中**（`ContextBar`）：工作区无对话时全身 Ewo、问候、起手式与输入框作为一个整体在可用区域内**垂直居中**，有对话则回落到底部常规布局。输入卡上方有**可选择的上下文条**——**项目 pill**点开下拉〔🔍 搜索工作区 + 全部工作区列表(当前打勾·切换) + 「打开文件夹」新建工作区〕；**分支 pill**（仅 git 仓库显示）点开下拉〔🔍 搜索分支 + 分支列表(当前打勾·显示「未提交的更改 N 个文件」·`gitSwitch` 切换) + 「Git 图谱」开右侧工作台面板〕；同一行保留思考档位。
- **斜杠命令**（输入「/」弹自动补全面板，两阶段：命令名 → 参数；↑↓ 选 / Enter·Tab 确认 / Esc 关）：面板头显示当前阶段，列表右侧直接显示**当前值 / 当前项**，`/compact` 会带上当前上下文占比。支持 `/think <档位>` 切思考、`/model` 先选 provider/本地来源再选模型、`/skill <技能名>` 手动调用全局或当前工作区 Skill、Chat 专属 `/learn` 从当前对话准备 Skill 学习提示、`/compact` 手动压缩上下文；已禁用的 Skill 不出现在候选中。
- **思考能力（分级，关/低/中/高）**：**云端**（DeepSeek-V4 等推理模型）经 pi `setThinkingLevel` 与对应 API family 的推理参数下发；**本地**（llama.cpp）注入 `chat_template_kwargs.enable_thinking` + `thinking_budget_tokens`。`/models.modelSources[].reasoning` 把运行时能力同步给 Chat / Workspace：没有个人偏好时，推理模型对齐 pi 默认「中」，非推理模型默认「关」；显式选择「关」也会按 route id 持久化。**自动重试**（provider 抖动退避重试，状态条提示）、**prompt caching**（仅 `anthropic-messages` API 注入 `cacheRetention:"long"`）默认开启；**上下文压缩**自动阈值触发或 `/compact` 手动触发，进度经状态条提示。
- **消息操作**：助手回答下方「复制」（整条）；**代码块**独立顶栏（语言标签 + 复制）；用户最后一条消息下方「重试」（原文重新生成）/「编辑」（内联改文后重新生成）——重新生成经 pi `navigateTree` 回滚上一轮、旧问答分叉离开上下文（上下文正确），UI 替换旧答案而非追加。
- **文件类型图标体系**：`lib/filetype.ts` 统一扩展名 → 角标文字 + 品牌色 + lucide 图标（工具行 / 文件树共用）。
- **设置（整页内嵌，非弹层；覆盖整窗含标题栏）**：左导航 6 项切换——**通用** / **模型** / **渠道** / **Skills** / **MCP** / **记忆**。设置页由 `SettingsHost` 这个 page-host module 承载：维护 section registry、visited keep-alive、上次分区 localStorage、`ew:open-settings` 定向打开与返回关闭契约，`App.tsx` 只持有打开/关闭句柄。**统一外壳**：每页共用同一套**大标题 + 自适应留白**（横向 `clamp` 内边距随窗口缩放，切 tab 不跳动）；通用的 `ConfigDisclosure` 把次级配置统一为“摘要 + 按需展开”。**通用**用卡片行（标题 + 说明左、控件右）维护界面主题（浅色 / 深色 / 跟随系统）与 HF 镜像开关。模型 / 渠道 / Skills / MCP / 记忆五个管理页以 keep-alive 内嵌（取代旧「插件页」+ 弹窗）；**模型页（本地）**顶部含**网络访问**卡——开关只改变 llama router 的监听地址（开=0.0.0.0 须 api-key、关=仅本机），并列出 router 自带的 `/v1` 直连端点；它不会改变 core/Fastify `/v1` 网关自己的监听地址。**记忆**把向量召回状态收进紧凑运行状态组；宿主已注入 Additive Provider 时才追加其状态 / 开关，当前设置页不提供接入表单。旧 Skills 迁移审计无歧义项时折叠，有待判断项时自动展开并强调数量（原「向量记忆」页已并入）。**Skills**把自动学习配置从主导航 / 主操作中分离为响应式折叠面板，并提供待审核数量 / 失败提醒、反馈 patch 和快照时间线。左导航宽度跟随主侧栏（分割线对齐），并会**记住上次停留的分区**；从聊天 / 工作区入口打开设置时也可直接落到指定 section。模型页支持**删除本地模型**（hover 显形，删的若是向量记忆引擎会一并停嵌入进程）。
- **统一弹层**：删除确认 / 文本输入 / 列表选择共用一套对话框外壳（`useConfirm` + `.confirm-box`），替代 Tauri WKWebView 不可靠的 `window.confirm` / `prompt`。

## 作为 OpenAI / Anthropic 端点（网关）

daemon 暴露 `/v1`，可让 Claude Code 等外部工具直接指向：

```bash
curl http://127.0.0.1:<port>/v1/chat/completions \
  -H "authorization: Bearer <token>" -H "content-type: application/json" \
  -d '{"model":"<model>","messages":[{"role":"user","content":"你好"}]}'
```

- **OpenAI 兼容**：`/v1/chat/completions`（+stream）、`/v1/embeddings`、`/v1/models`。
- **Anthropic 兼容**：`/v1/messages`（流式 message_start → content_block_* → message_delta → message_stop）。
- **路由**：本地模型透传到统一 `llama serve` router 的端点（按 `model` 字段二次路由 + tool_use）；云端经 pi-ai（流式 `streamSimple` / 非流式 `completeSimple`，统一鉴权 / OAuth），出错回退引擎。
- `/v1/models` 只返回 OpenAI-shaped 模型列表；带 Bearer 的内部 `GET /models` 另返回 `endpoints/context/bindHost`，`GET /settings/local-net` 返回 `lanIp/apiKey/endpoints` 供 UI 生成 router 直连地址。
