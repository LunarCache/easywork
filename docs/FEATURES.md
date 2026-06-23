# EasyWork · 功能与设计

> 功能详解。概览见 [README](../README.md)；架构 / 技术栈 / 环境变量见 [ARCHITECTURE](ARCHITECTURE.md)；进度见 [PROGRESS](PROGRESS.md)；开发约定见 [CLAUDE.md](../CLAUDE.md)。

## 模型

- **本地**：从 HuggingFace 搜索、下载（断点续传）GGUF，经统一 `llama` 的 **router 模式**运行 —— 单个 `llama serve --models-dir` 进程按请求 `model`（= 模型子目录名）路由、按需 auto-load、`--models-max` LRU 淘汰（文本 / 视觉）。加载默认用模型**原生最大上下文长度**（GGUF `context_length`，未知回退 4096）。嵌入模型（记忆 / 知识库）走**独立**的 `llama serve -m --embedding` 进程，与 router 分离：启动时若磁盘已有嵌入 GGUF 则自动拉起（缺失则记忆 / KB 降级纯词法，不崩）；可在**设置 →「向量记忆」**一键启用（下载 nomic-embed + 重建索引），状态同步显示在**模型页**（嵌入卡「运行中 / 已启用」）。
- **云端**：通用 **OpenAI-兼容** provider，接 OpenAI / OpenRouter / DeepSeek / vLLM 等（「模型 → 云端 API」页管理，带常见端点预设）。可**手动配置上下文窗口**（云端无法自动探测，用于 compaction 阈值 + 进度环；缺省 32768）。

## Agent 内核 = pi-coding-agent（托管）

- 内核为托管 [`@earendil-works/pi`](https://github.com/earendil-works/pi) 的 `AgentSession`（无头嵌入）：自带编码工具（read/bash/edit/write/grep/ls/find）、自动上下文 compaction、会话管理。EasyWork 是它的宿主 / 集成层。
- **真实工具审批流（4 档）**：`read-only` / `approve-each` / `auto-edits` / `full-auto`，经 pi `tool_call` 钩子映射；危险工具经 SSE 挂起，UI 弹窗「允许 / 总是允许 / 拒绝」。
- **工作区路径限定**：fs 工具路径经 realpath 解析后硬拦越界（含软链接），bash 由审批把守。
- **内置工具**（桥成 pi customTool）：`get_time` / `calculator` / `http_get`（带 SSRF 防护）/ `web_search`。
- **记忆 / 知识库 / 会话检索**：记忆经 pi 扩展接入——**渐进式披露**（记忆「清单」注入系统提示词 + `recall_memory` 工具按需取全文，借鉴 Skill）+ **批量事实抽取**（空闲 / 关闭时，非每轮）；知识库 / 会话检索为 customTools。
- **MCP**：stdio（默认禁用，需开关）+ HTTP；工具桥成 pi customTools；导入标准 `mcpServers` JSON。
- **Skills**：pi 自带 skills（resourceLoader 发现）+ 应用内 Skills 管理。

## 工作区模式

在本地项目目录里读写文件 / 跑命令（git 改动审阅面板）。聊天模式也能写文件 / 跑命令，但**限定在每会话工件目录内**。两种模式共用右侧常驻「工作台」面板（见下方桌面 UI）。

## 文档知识库 RAG

本地文件上传 → 异步解析（带进度）→ 分块 → 嵌入 → **RRF 混合检索**（sqlite-vec 语义 + 词法）→ 多集合作用域（面板内「+ 新建集合」分类，上传按集合归档）→ 首轮自动注入 + 引用来源。

## 可插拔记忆（作用域化）

**全局池**（所有对话共享）+ **每工作区私有池**（互相隔离、独立于全局，工作区盯约定 / 变动 / 坑）；**渐进式披露**注入（清单常驻 + 按需取全文）+ **批量抽取**（非每轮）；**sqlite-vec ⊕ 词法**混合召回；全局 markdown 可手改回灌；记忆页按作用域浏览 / 编辑 / 清空；Mem0 适配器。

## 采样参数

`temperature / top_p / top_k / min_p / repeat_penalty / frequency_penalty / presence_penalty / reasoning_effort`，全链路透传，**按模型**保存（聊天内快捷浮层）。

## 思维链

`<think>` 与 gpt-oss harmony 多通道（analysis → 思考 / final → 正文）解析；**思考过程持久化**（作为 reasoning 片段落库），切换 / 重载会话仍可展开回放（不回喂模型）。

## 本地端口暴露

router（`llama serve`）默认仅绑 `127.0.0.1`；可在「设置 → 本地网络」切到 `0.0.0.0` 让局域网其他服务直连（**强制设置 api-key**，未鉴权拒绝；切换会重启 router 立即生效）。

## 桌面 UI（"Agent Tasks"）

IDE / 终端味设计语言（IBM Plex Sans / JetBrains Mono · 统一图标描边 1.8 · **明暗双主题 + 跟随系统** · 强调色 blue/iris/violet，挂 `<html>` data-theme/data-accent）。

- **外壳**：两段式标题栏（段 A = 实时侧栏宽 + macOS 原生红绿灯 + 侧栏开关；段 B = 面包屑〔任务名 + 工作区 / 分支 pill〕+ 工作台开关〔动态图标，开/关不同〕）+ 展开式侧栏 + 可拖拽对话区 + 右侧常驻工作台面板。
- **展开式侧栏**：顶部快捷操作（新对话 ⌘N / 打开工作区 / 收件箱 / 插件）+「项目」分区（工作区折叠组，CWD 角标 / 文件树 / 删除）+「对话」分区（独立聊天）+ 底部设置 + 连接状态点。
- **插件页**（点「插件」在主区打开，顶部标签切换）：模型 / 知识库 / Skills / MCP / 记忆 五管理页**内嵌**渲染（取代弹窗）。
- **对话区**：用户 `acc-weak` 软气泡右对齐 / AI 无头像纯 prose 左对齐；**行内工具调用**（思考 / 编辑〔文件类型角标 + `+/-`〕/ 运行〔命令 + 状态〕/ 读取 / 搜索，点击展开 diff / 终端 / 来源）+ **文件改动汇总卡**（消息底部，点击跳转查看 diff）+ 流式 / 引用 / HTML 工件 / 图片多模态 / 审批。
- **工作台面板**（常驻、可拖拽，对话区与工作区共用）：**启动菜单**（改动〔git 仓库〕/ 文件 ⌘P / 浏览器 ⌘T / 终端 大行）→ 选中进对应视图（git 审查 / 文件树内联预览 / 终端 / 网页），顶部带返回 / 放大 / 关闭。
- **composer**：textarea + 底栏（`+` 菜单收纳 思考 / 联网 / 知识库 开关 · 上下文用量环 · 模型选择 · 生成参数 · 圆形发送），保持单行、挤不下优雅换行。
- **文件类型图标体系**：`lib/filetype.ts` 统一扩展名 → 角标文字 + 品牌色 + lucide 图标（工具行 / 知识库 / 文件树共用）。
- **设置**：仅通用配置（明暗模式〔浅色 / 深色 / 跟随系统〕/ 强调色 / Agent 循环 / 向量记忆 / 本地网络）。

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
