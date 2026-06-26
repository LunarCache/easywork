# EasyWork · 功能与设计

> 功能详解。概览见 [README](../README.md)；架构 / 技术栈 / 环境变量见 [ARCHITECTURE](ARCHITECTURE.md)；进度见 [PROGRESS](PROGRESS.md)；开发约定见 [CLAUDE.md](../CLAUDE.md)。

## 模型

- **本地**：从 HuggingFace 搜索、下载（断点续传）GGUF，经统一 `llama` 的 **router 模式**运行 —— 单个 `llama serve --models-dir` 进程按请求 `model`（= 模型子目录名）路由、按需 auto-load、`--models-max` LRU 淘汰（文本 / 视觉）。加载默认用模型**原生最大上下文长度**（GGUF `context_length`，未知回退 4096）。嵌入模型（记忆 / 知识库）走**独立**的 `llama serve -m --embedding` 进程，与 router 分离：启动时若磁盘已有嵌入 GGUF 则自动拉起（缺失则记忆 / KB 降级纯词法，不崩）；可在**设置 →「记忆」页工具栏**一键启用向量召回（下载 nomic-embed + 重建索引），状态同步显示在**模型页**（嵌入卡「运行中 / 已启用」）。
- **云端**：通用 **OpenAI-兼容** provider，接 OpenAI / OpenRouter / DeepSeek / vLLM 等（「模型 → 云端 API」页管理，带常见端点预设）。可**手动配置上下文窗口**（云端无法自动探测，用于 compaction 阈值 + 进度环；缺省 32768）。

## Agent 内核 = pi-coding-agent（托管）

- 内核为托管 [`@earendil-works/pi`](https://github.com/earendil-works/pi) 的 `AgentSession`（无头嵌入）：自带编码工具（read/bash/edit/write/grep/ls/find）、自动上下文 compaction、会话管理。EasyWork 是它的宿主 / 集成层。
- **真实工具审批流（4 档）**：`read-only` / `approve-each` / `auto-edits` / `full-auto`，经 pi `tool_call` 钩子映射；危险工具经 SSE 挂起，UI 在**对话栏上方弹出审批卡**（内嵌、非遮罩弹层；简洁单头行 = 盾牌 + 工具名 accent 胶囊 + 右侧紧凑按钮，下方单行参数预览〔命令/路径/紧凑 JSON，悬停看全〕，Chat/Workspace 共用 `ApprovalCard`）「允许 / 总是允许 / 拒绝」。
- **工作区路径限定**：fs 工具路径经 realpath 解析后硬拦越界（含软链接），bash 由审批把守。
- **内置工具**（桥成 pi customTool）：`get_time` / `calculator` / `http_get`（带 SSRF 防护）/ `web_search`。
- **记忆 / 知识库 / 会话检索**：记忆经 pi 扩展接入——**渐进式披露**（记忆「清单」注入系统提示词 + `recall_memory` 工具按需取全文，借鉴 Skill）+ **批量事实抽取**（空闲 / 关闭时，非每轮）；知识库 / 会话检索为 customTools。
- **MCP**：stdio（默认禁用，需开关）+ HTTP；工具桥成 pi customTools；导入标准 `mcpServers` JSON；连接探测（带超时）+ 工具清单预览 + 编辑已有配置（保留 OAuth / env）+ 探测失败错误详情；`callTool` 透传中断信号。
- **Skills**：pi 自带 skills（resourceLoader 发现）+ 应用内 Skills 管理。

## 工作区模式

在本地项目目录里读写文件 / 跑命令（git 改动审阅面板）。聊天模式也能写文件 / 跑命令，但**限定在每会话工件目录内**。两种模式共用右侧常驻「工作台」面板（见下方桌面 UI）。

## 文档知识库 RAG

本地文件上传 → 异步解析（带进度）→ 分块 → 嵌入 → **RRF 混合检索**（sqlite-vec 语义 + 词法）→ 多集合作用域 → 首轮自动注入 + 引用来源。**知识库页**：左集合栏（每集合计数 + 处理中指示）+ 右文档卡片网格 + 文档预览（统一 `FileViewer`：md 渲染 / 代码高亮 / 纯文本）；顶部上传先选目标集合、行内新建集合（名规范化为合法 kbId，集合在有文件那一刻诞生）；ingest job 进度轮询。

## 可插拔记忆（作用域化）

**全局池**（所有对话共享）+ **每工作区私有池**（互相隔离、独立于全局，工作区盯约定 / 变动 / 坑）；**渐进式披露**注入（清单常驻 + 按需取全文）+ **批量抽取**（非每轮）；**sqlite-vec ⊕ 词法**混合召回；全局 markdown 可手改回灌；Mem0 适配器。**记忆页（档案 Dossier）**：左作用域栏（全局 / 你 + 各工作区，带计数）+ 右按层分区（层语义色点 + 行内添加）；记忆卡带**来源徽章**（手动 / 自动抽取）+ 相对时间 + 行内编辑 / 删除；顶部搜索（作用域内过滤）+ 向量召回状态；空作用域 / 空层可从「+ 添加」选目标加第一条。

## 采样参数

`temperature / top_p / top_k / min_p / repeat_penalty / frequency_penalty / presence_penalty / reasoning_effort`，全链路透传，**按模型**保存（聊天内快捷浮层）。

## 思维链

`<think>` 与 gpt-oss harmony 多通道（analysis → 思考 / final → 正文）解析；**思考过程持久化**（作为 reasoning 片段落库），切换 / 重载会话仍可展开回放（不回喂模型）。

## 本地端口暴露

router（`llama serve`）默认仅绑 `127.0.0.1`；可在「设置 → 通用 → 本地网络」切到 `0.0.0.0` 让局域网其他服务直连（**强制设置 api-key**，未鉴权拒绝；切换会重启 router 立即生效）。

## 桌面 UI（"Agent Tasks"）

IDE / 终端味设计语言（IBM Plex Sans / JetBrains Mono · 统一图标描边 1.8 · **明暗双主题 + 跟随系统**，挂 `<html>` data-theme）。

- **外壳**：两段式标题栏（段 A = 实时侧栏宽 + macOS 原生红绿灯 + 侧栏开关；段 B = 面包屑〔任务名 + 工作区 / 分支 pill〕+ 工作台开关〔动态图标，开/关不同〕）+ 展开式侧栏 + 可拖拽对话区 + 右侧常驻工作台面板。
- **展开式侧栏**：顶部快捷操作（新对话 ⌘N / **搜索 ⌘K** / 打开工作区 / 收件箱）+「项目」分区（工作区折叠组，CWD 角标 / hover 新建会话 ＋ / 文件树 / 删除；分区头「折叠全部」）+「对话」分区（独立聊天，带相对时间）+ 底部设置 + 连接状态点。**全局搜索（⌘K）**：居中浮层跨 对话 / 工作区 / 工作区会话 模糊匹配，↑↓ 选 / Enter 跳转 / Esc 关。
- **对话区**：用户 `acc-weak` 软气泡右对齐 / AI 无头像纯 prose 左对齐；**行内工具调用**（Codex Flat 风：扁平左竖线、过去式步骤、零卡片零暗井，默认折叠、运行中展开）——连续只读勘探（读 / 搜 / 列 / 找）**聚合成「探索 · N」组**；**思考**左竖线 accent；**编辑**〔过去式「已编辑」+ 文件类型徽标 + 文件名(亮)/目录(灰) + `+/-`〕展开为**语法高亮 diff**（复用 `.hljs-*` 着色 + 双栏行号〔解析 `@@`〕 + 改动行红/绿竖条）；**运行**〔`SquareTerminal` 图标 + 过去式「已执行」+ 折叠态命令预览〕展开为浅底圆角卡（`$ 完整命令`悬挂缩进换行 + 灰输出，同卡）。**工作日志**：本轮全部过程（思考 + 工具）包进默认折叠的「已工作 N 分」容器（运行中展开看进度，结束折叠），**只把最终答复留在容器外**；助手回答下方带**时间戳** + **文件改动汇总卡**（消息底部，默认折叠、点击跳转查看 diff）+ 流式 / 引用 / HTML 工件 / 图片多模态 / 审批。**滚动到底浮钮**（上滚离底才现，自动滚动仅在底部附近跟随）。
- **工作台面板**（常驻、可拖拽，对话区与工作区共用）：**启动菜单**（改动〔git 仓库〕/ 文件 ⌘P / 浏览器 ⌘T / 终端 大行）→ 选中进对应视图（git 审查 / 统一文件预览 / 终端 / 网页），顶部带返回 / 放大 / 关闭。
- **统一文件预览**（`FileViewer` 组件 + `/files/meta`·`/files/raw` 端点）：一个组件按类型渲染——**图片**（鉴权 blob）/ **PDF**（浏览器原生）/ **Markdown**（渲染 ⇆ 源码）/ **SVG**（渲染 ⇆ 源码）/ **HTML**（沙箱 iframe ⇆ 源码）/ **代码 · 文本**（highlight.js 语法高亮）/ 二进制兜底下载。工作台「文件」tab、项目文件浏览页、知识库文档预览共用同一组件（数据源四态：工作区/会话文件、KB 文本、网页 URL、内联字节）。
- **composer**：textarea + 底栏（左 `+`〔聊天=菜单收纳 思考/联网/知识库 开关；工作区=图片上传〕· 工作区另有审批策略 pill〔只读 / 逐项确认 / 自动编辑 / 完全访问，完全访问橙色警示〕· 右 模型选择 · **思考档位 chip**〔关 / 低 / 中 / 高，点击循环，按模型持久化〕· 圆形发送；聊天另有上下文用量环 / 生成参数），保持单行、挤不下优雅换行。
- **工作区上下文条 + 空态居中**（`ContextBar`）：工作区无对话时输入框**居中**呈现（品牌标 + 按时段问候语「上午好呀…」），有对话则回落到底部常规布局。输入卡上方有**可选择的上下文条**——**项目 pill**点开下拉〔🔍 搜索工作区 + 全部工作区列表(当前打勾·切换) + 「打开文件夹」新建工作区〕；**分支 pill**（仅 git 仓库显示）点开下拉〔🔍 搜索分支 + 分支列表(当前打勾·显示「未提交的更改 N 个文件」·`gitSwitch` 切换) + 「Git 图谱」开右侧工作台面板〕。
- **斜杠命令**（输入「/」弹自动补全面板，两阶段：命令名 → 参数；↑↓ 选 / Enter·Tab 确认 / Esc 关）：`/think <档位>` 切思考、`/model <名>` 会话内切模型、`/compact` 手动压缩上下文。
- **思考能力（分级，关/低/中/高）**：**云端**（DeepSeek-V4 等 OpenAI-SDK 思考模型）经请求体注入 `thinking:{type:"enabled"/"disabled"}` + `reasoning_effort`——**关=真关**（省 reasoning token，非仅隐藏）；**本地**（llama.cpp）注入 `chat_template_kwargs.enable_thinking` + `thinking_budget_tokens`；pi 已登记的推理模型额外走 `setThinkingLevel`。**自动重试**（provider 抖动退避重试，状态条提示）、**prompt caching**（仅 Anthropic-shaped API `cacheRetention=long`）默认开启；**上下文压缩**自动阈值触发或 `/compact` 手动触发，进度经状态条提示。
- **消息操作**：助手回答下方「复制」（整条）；**代码块**独立顶栏（语言标签 + 复制）；用户最后一条消息下方「重试」（原文重新生成）/「编辑」（内联改文后重新生成）——重新生成经 pi `navigateTree` 回滚上一轮、旧问答分叉离开上下文（上下文正确），UI 替换旧答案而非追加。
- **文件类型图标体系**：`lib/filetype.ts` 统一扩展名 → 角标文字 + 品牌色 + lucide 图标（工具行 / 知识库 / 文件树共用）。
- **设置（整页内嵌，非弹层）**：左导航 6 项切换——**通用**（明暗模式〔浅色 / 深色 / 跟随系统〕+ **本地网络**〔网络访问 仅本机 / 局域网 · API Key · 端点列表〕，卡片堆叠）/ **模型** / **知识库** / **Skills** / **MCP** / **记忆**（工具栏自带**向量召回**状态 + 启用，原独立「向量记忆」页已并入）；模型 / 知识库 / Skills / MCP / 记忆 五管理页以 keep-alive 内嵌（取代旧「插件页」+ 弹窗）。通用类用卡片行（标题 + 说明左、控件右）。左导航宽度跟随主侧栏（分割线对齐）。模型页支持**删除本地模型**（hover 显形，删的若是向量记忆引擎会一并停嵌入进程）。
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
- `/v1/models` 含 `endpoints`（router 对外 baseUrl/port，供外部直连）。
