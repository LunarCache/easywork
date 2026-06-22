# EasyWork · 本地 AI 工作台

> 纯推理（无训练 / 微调）的跨平台本地 AI 工作台。下载并运行本地 GGUF 模型，也可接云端 OpenAI-兼容模型；具备 Agent 工具能力（内置工具 / Skills / MCP）、文档知识库 RAG、可插拔记忆系统；支持应用内聊天与外部 IM 渠道。
>
> TypeScript 全栈，跨 Linux / macOS / Windows。能力**思路**参考 Unsloth Studio 与 Hermes Studio，独立实现。

---

## ✨ 特性

- **本地 / 云端模型**
  - 本地：从 HuggingFace 搜索、下载（断点续传）GGUF，经 `llama-server` 子进程运行（文本 / 视觉 / embedding）。每模型一进程，带 LRU 淘汰。加载默认用模型**原生最大上下文长度**（GGUF `context_length`，未知回退 4096）。
  - 云端：通用 **OpenAI-兼容** provider，接 OpenAI / OpenRouter / DeepSeek / vLLM 等（在「模型 → 云端 API」页管理，带常见端点预设）。可**手动配置上下文窗口**（云端无法自动探测，用于 compaction 阈值 + 进度环；缺省 32768）。
- **Agent 内核 = pi-coding-agent（托管）**
  - 内核为托管 [`@earendil-works/pi`](https://github.com/earendil-works/pi) 的 `AgentSession`（无头嵌入）：自带编码工具（read/bash/edit/write/grep/ls/find）、自动上下文 compaction、会话管理。EasyWork 是它的宿主/集成层。
  - **真实工具审批流（4 档）**：`read-only` / `approve-each` / `auto-edits` / `full-auto`，经 pi `tool_call` 钩子映射；危险工具经 SSE 挂起，UI 弹窗「允许 / 总是允许 / 拒绝」。
  - **工作区路径限定**：fs 工具路径经 realpath 解析后硬拦越界（含软链接），bash 由审批把守。
  - 内置工具（桥成 pi customTool）：`get_time` / `calculator` / `http_get`（带 SSRF 防护）/ `web_search`。
  - **记忆/知识库/会话检索**：记忆经 pi 扩展接入——**渐进式披露**（记忆「清单」注入系统提示词 + `recall_memory` 工具按需取全文，借鉴 Skill）+ **批量事实抽取**（空闲/关闭时，非每轮）；知识库 / 会话检索为 customTools。
  - **MCP**：stdio（默认禁用，需开关）+ HTTP；工具桥成 pi customTools；导入标准 `mcpServers` JSON。
  - **Skills**：pi 自带 skills（resourceLoader 发现）+ 应用内 Skills 管理。
- **工作区模式**：在本地项目目录里读写文件 / 跑命令（git 改动审阅面板）。聊天模式也能写文件 / 跑命令，但**限定在每会话工件目录内**。两种模式共用**右侧「工作台坞」**（改动 / 文件 / 终端 / 预览四 tab，详见下方桌面 UI）。
- **文档知识库 RAG**：本地文件上传 → 异步解析（带进度）→ 分块 → 嵌入 → **RRF 混合检索**（sqlite-vec 语义 + 词法）→ 多集合作用域 → 首轮自动注入 + 引用来源。
- **可插拔记忆（作用域化）**：**全局池**（所有对话共享）+ **每工作区私有池**（互相隔离、独立于全局，工作区盯约定 / 变动 / 坑）；**渐进式披露**注入（清单常驻 + 按需取全文）+ **批量抽取**（非每轮）；**sqlite-vec ⊕ 词法**混合召回；全局 markdown 可手改回灌；记忆页按作用域浏览 / 编辑 / 清空；Mem0 适配器。
- **采样参数**：`temperature / top_p / top_k / min_p / repeat_penalty / frequency_penalty / presence_penalty / reasoning_effort`，全链路透传，**按模型**保存（聊天内快捷浮层）。
- **多协议端点（网关）**：`/v1/chat/completions`（+stream）、`/v1/embeddings`、`/v1/models`（OpenAI 兼容）、`/v1/messages`（Anthropic 兼容）。本地模型**透传**到其 llama-server 原生端点（OpenAI + 原生 Anthropic）；云端**流式经 pi-ai**（统一鉴权，含 OAuth）。可让 Claude Code 等外部客户端直接指向。
- **本地端口暴露**：llama-server 默认仅绑 `127.0.0.1`；可在「设置 → 本地网络」切到 `0.0.0.0` 让局域网其他服务直连（**强制设置 api-key**，未鉴权拒绝）。
- **思维链**：`<think>` 与 gpt-oss harmony 多通道（analysis → 思考 / final → 正文）解析；**思考过程持久化**（作为 reasoning 片段落库），切换 / 重载会话仍可展开回放（不回喂模型）。
- **桌面 UI（Agent Desk 工作台）**：冷灰 + 靛蓝设计语言（IBM Plex Sans / JetBrains Mono · 明暗双主题 · iris/teal/amber 三色 + 紧凑/舒适密度，挂 `<html>` data-*）。布局 = 标题栏 + **图标轨道模式切换（对话 / 工作区 / 收件箱）** + 分组会话列表（工作区按项目→会话，CWD 角标）+ 可拖拽对话区（用户**强调色气泡右对齐** / AI 消息头像左对齐；THINK·SEARCH·READ·EDIT-diff·RUN-terminal **统一工具卡** + 流式 / 引用 / HTML 工件 / 图片多模态 / 审批；composer **上下文用量进度环**）+ **统一右侧「工作台坞」**（对话区与工作区共用，一坞四 tab：**改动**（git 审查，按需）/ **文件**（工件 + 文件树内联预览，📂 在文件管理器打开目录）/ **终端**（看 AI 命令 + `$` 自己跑命令）/ **预览**（点来源 / 链接内联看网页、不导航走 app，⤢ 放大到整窗）） + Settings（模型 / 知识库 / Skills / MCP / 通用，Skills·MCP 行卡片开关）/ Memory 浮层。

---

## 🧱 架构：Core Daemon 模型

一个无头的 Node **核心守护进程（`@ew/core`）拥有全部"大脑"**：托管 pi-coding-agent 内核（`SessionHost`）、推理（llama-server 进程管理 + 云端 provider）、工具 / Skills / MCP、记忆、知识库、SQLite 存储。对外暴露**本地 HTTP API + SSE**（Fastify）。Tauri 桌面壳、外部 IM 连接器、以及任意 `/v1` 客户端都是它的**瘦客户端**——同一个大脑既服务应用内聊天，也服务外部渠道，还能无头运行。

```
                 ┌──────────────────────────────────────────┐
                 │            CORE DAEMON (@ew/core)          │
                 │  pi-coding-agent 内核(SessionHost 托管)     │
                 │  ew-extensions(记忆/权限/桥接工具)          │
                 │  llama-server host · skills · MCP · RAG     │
                 │  SQLite store · /v1 网关(本地透传+云端 pi)  │
                 │  Fastify HTTP + SSE + /v1 + /v1/messages    │
                 └──────────────────────────────────────────┘
    spawn sidecar ▲       ▲ HTTP+SSE        ▲ HTTP+SSE    ▲ HTTP /v1
  ┌───────────────┘       │                 │            │
  │ Tauri 主进程(Rust)    │ IM connectors   │ React UI   │ Claude Code /
  │  └ webview(React)     │ (TG/Discord/…)  │ (@ew/sdk)  │ 任意 /v1 客户端
  └───────────────────────┴─────────────────┴────────────┘
```

- **Tauri 主进程（Rust）**：窗口 / 菜单 / 自动更新 + 以 sidecar spawn 并健康检查 daemon。读取 daemon stdout 首行的 `{baseUrl, token}`，经 `get_config` 注入 webview（连接信息对 UI 不可见）。
- **Core daemon**：detached Node 子进程（`easywork serve`），也可独立无头运行。
- **本地推理**：每个加载的模型一个 `llama-server` 子进程。DB 用内置 `node:sqlite`；唯一原生件是 **sqlite-vec** 可加载扩展（随包提供各平台预编译二进制，记忆 / 知识库向量召回用；缺失则降级纯词法）。

---

## 📦 Monorepo 结构（npm workspaces + Turborepo）

```
packages/
  shared/         @ew/shared        纯 zod schema + 类型（契约层，零运行时依赖）
  core/           @ew/core          daemon 库：server / routes / SessionHost(托管 pi) / ew-extensions / /v1 网关 / RAG / store
  providers/      @ew/providers     LlamaServerEngine（--host/--api-key）/ OpenAICompatibleEngine / harmony 解析
  memory/         @ew/memory        MemoryProvider：local（作用域化分层 + SqliteVecIndex 语义 ⊕ 词法召回）+ mem0
  tools/          @ew/tools         内置工具 + SSRF 防护
  skills/         @ew/skills        Skills 发现 / 渐进披露 / 执行
  mcp/            @ew/mcp           MCP client（stdio + HTTP）
  im-connectors/  @ew/im-connectors telegram（discord / wecom / feishu 规划中）
  sdk/            @ew/sdk           daemon HTTP API 的类型化客户端
apps/
  desktop/        @ew/desktop       Tauri 2 外壳（Rust src-tauri）+ sidecar 启动 daemon
  ui/             @ew/ui            React 19 + Vite 前端
  daemon/         @ew/daemon        CLI 入口 easywork serve
```

依赖方向：所有包依赖 `shared`；`core` 是库，被 `apps/daemon` 与 `apps/desktop` 共同消费。

---

## 🛠 技术栈

| 关注点 | 选型 |
|---|---|
| Agent 内核 | `@earendil-works/pi`（pi-coding-agent）`AgentSession` 无头托管；记忆/工具/权限经扩展 + customTools 接入 |
| 本地推理 | llama.cpp `llama-server` 子进程（OpenAI + 原生 Anthropic；文本 / `--mmproj` 视觉 / `--embedding`） |
| HTTP | Fastify（schema-first、原生 SSE） |
| 契约 / 校验 | zod + zod-to-json-schema |
| 本地 DB | `node:sqlite`（内置 DatabaseSync，零原生编译） |
| 记忆 / RAG | 本地 CPU embedding（nomic-embed-text 768 维）+ **sqlite-vec** 语义 ⊕ 词法混合召回（RRF）；记忆作用域化 + 渐进式披露 |
| UI | React 19 + Vite + react-markdown |
| 桌面 | Tauri 2（Rust 外壳 + TS 前端，sidecar 启动 daemon） |
| 库构建 / 测试 | tsup（esbuild） / Vitest |
| Monorepo | npm workspaces + Turborepo |

---

## 🚀 快速开始

环境：**Node ≥ 20**（推荐 26）、npm 11、`llama-server`（本地推理用，Mac `brew install llama.cpp`；env `EW_LLAMA_SERVER` 可指定路径）。桌面需 Rust 工具链（`cargo`）。

> **Windows 运行需安装 Git**（[Git for Windows](https://git-scm.com/download/win)）。工作区模式用它做两件事：① git 改动审阅面板；② 命令执行工具（`run_command`）会优先用 Git 自带的 **bash.exe** + Unix 工具（`ls`/`cat`/`grep` 等）执行命令，否则模型生成的 Unix 命令在 `cmd.exe` 下无法运行。装好后通常自动探测；如未在标准路径，可用 env `EW_GIT_BASH` 指定 `bash.exe` 路径。macOS / Linux 用系统自带 `/bin/sh` + git，无需额外配置。

```bash
npm install            # 安装全部 workspace 依赖
npm run build          # turbo 构建全部包
npm test               # vitest（204 测试）
npm run typecheck      # 全量类型检查
npm run lint           # eslint
```

### 无头 / 浏览器开发

```bash
npm run dev:daemon     # 仅起 daemon（stdout 首行打印 {baseUrl, token, pid}）
npm run dev:ui         # 起 Vite (http://localhost:5173)
# 浏览器直接连 daemon：访问 http://localhost:5173/?baseUrl=<daemon>&token=<token>
```

### 桌面（Tauri）

```bash
npm run dev:desktop    # tauri dev：编译 Rust 壳、起 Vite、spawn daemon sidecar
```

### 直接跑 daemon

```bash
node apps/daemon/dist/cli.js serve --port 0
```

---

## 🔌 作为 OpenAI / Anthropic 端点

daemon 暴露 `/v1`，可让外部工具指向：

```bash
curl http://127.0.0.1:<port>/v1/chat/completions \
  -H "authorization: Bearer <token>" -H "content-type: application/json" \
  -d '{"model":"<model>","messages":[{"role":"user","content":"你好"}]}'
```

- OpenAI 兼容：`/v1/chat/completions`、`/v1/embeddings`、`/v1/models`
- Anthropic 兼容：`/v1/messages`（流式 message_start → content_block_* → message_delta → message_stop）
- 路由：**本地模型**透传到其 llama-server 原生端点（两种协议 + tool_use）；**云端**经 pi-ai（流式 `streamSimple` / 非流式 `completeSimple`，统一鉴权/OAuth），出错回退引擎。
- `/v1/models` 含 `endpoints`（各本地模型对外 baseUrl/port，供外部直连 llama-server）。

---

## 🔐 环境变量

| 变量 | 作用 |
|---|---|
| `EW_LLAMA_SERVER` | 指定 `llama-server` 可执行文件路径 |
| `EW_MAX_LOADED_MODELS` | 最大常驻模型数（默认 3，超出按 LRU 淘汰） |
| `EW_ALLOW_STDIO_MCP=1` | 允许 stdio MCP（默认禁用，会在本机执行任意命令） |
| `EW_DATA_DIR` | 数据目录（默认 `~/.easywork`） |

> 本地网络暴露（绑定 host `127.0.0.1`/`0.0.0.0` 与 api-key）在 daemon 的 SQLite `settings` 表中持久化，由 UI「设置 → 本地网络」管理（非环境变量）。

---

## 📍 开发进度

### ✅ 已完成

- **核心守护进程**（`@ew/core`）：Fastify HTTP + SSE，托管 pi-coding-agent 内核（`SessionHost`，按 threadId 串行化），无头可运行（`easywork serve`）。
- **本地推理**：`llama-server` 子进程管理（文本 / 视觉 / embedding），每模型一进程 + LRU 淘汰；HF 搜索 / 断点续传下载 / GGUF 头解析。
- **云端推理**：OpenAI 兼容 provider（OpenAI / OpenRouter / DeepSeek / vLLM …），云端流式经 pi-ai（含 OAuth）。
- **多协议网关**：`/v1/chat/completions`（+stream）/ `/v1/embeddings` / `/v1/models`（OpenAI）+ `/v1/messages`（Anthropic）；本地透传、云端经 pi。
- **Agent 工具**：内置工具（time/calculator/http_get+SSRF/web_search）、MCP（stdio+HTTP）、Skills，全桥成 pi customTools；审批 4 档 + 工作区路径限定。
- **工作区模式**：本地项目目录读写文件 / 跑命令 + git 改动审阅面板；聊天模式工件目录。对话区与工作区共用右侧「工作台坞」（改动 / 文件 / 终端 / 预览）。
- **记忆（作用域化）**：全局池 + 每工作区私有池；渐进式披露注入 + 批量事实抽取；sqlite-vec ⊕ 词法混合召回；markdown 可手改回灌。
- **知识库 RAG**：上传 → 解析 → 分块 → 嵌入 → RRF 混合检索 + 引用来源。
- **思考过程持久化**：reasoning 落库并跨会话回放（不回喂模型）。
- **桌面 / UI**：Tauri 2 外壳（sidecar 拉起 daemon）+ React 前端（**Agent Desk 工作台**设计语言：冷灰 + 靛蓝 · IBM Plex/JetBrains · 明暗 + 三色 accent + 密度）；标题栏 + 图标轨道（对话/工作区/收件箱）+ 分组会话列表 + 三栏可拖拽 + 统一「工作台坞」（改动/文件/终端/预览，可放大到整窗）+ 设置/记忆浮层。
- **存储**：`node:sqlite`（ConversationRepo + FTS5 全文检索 + 设置 / provider / MCP 持久化）。

### 🚧 待做

- **IM 连接器**：Telegram 已实现；**Discord / 企业微信 / 飞书待补**（需实盘凭证联调）。
- **桌面打包分发**：Tauri 三平台安装包 + 随附 `llama-server` / `sqlite-vec` 二进制冒烟（目前仅 `cargo check` + dev 实跑验证）。
- **代码执行沙箱**：python / terminal 的独立 OS 级隔离（当前经 pi `bash` 工具 + 审批 4 档把守，无独立沙箱）。
- **密钥存储**：provider / MCP key 现存 SQLite `settings`，待迁 OS keychain（keytar / Tauri stronghold）。
- **工作区 v2**：多会话回放 ✅、提交历史 ✅、push/pull ✅、接受 / 拒绝单改动（per-hunk 暂存 / 取消暂存 / 丢弃）✅ 已完成；仅剩 **内嵌可编辑编辑器**（按需）。
- 个人微信无官方机器人 API → 仅做企业微信。

> **关于持久化**：pi `SessionManager` 已按 threadId 落盘 + resume，daemon 重启后模型仍带上重启前上下文；`ConversationRepo` 仍是 UI / 全文检索 / 渠道映射 / 项目元数据的真相源（两者并存，刻意不做"单一真相源"替换——会丢 FTS5 检索 / 渠道映射且大改 UI/SDK 而无净收益）。

进展详见 [`docs/PROGRESS.md`](docs/PROGRESS.md)，约定与架构详见 [`CLAUDE.md`](CLAUDE.md)。

---

## 📄 许可

私有项目。能力思路参考 Unsloth Studio（AGPL-3.0）与 Hermes Studio，但为独立实现，不复制其代码。
