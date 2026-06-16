# EasyWork · 本地 AI 工作台

> 纯推理（无训练 / 微调）的跨平台本地 AI 工作台。下载并运行本地 GGUF 模型，也可接云端 OpenAI-兼容模型；具备 Agent 工具能力（内置工具 / Skills / MCP）、文档知识库 RAG、可插拔记忆系统；支持应用内聊天与外部 IM 渠道。
>
> TypeScript 全栈，跨 Linux / macOS / Windows。能力**思路**参考 Unsloth Studio 与 Hermes Studio，独立实现。

---

## ✨ 特性

- **本地 / 云端模型**
  - 本地：从 HuggingFace 搜索、下载（断点续传）GGUF，经 `llama-server` 子进程运行（文本 / 视觉 / embedding）。每模型一进程，带 LRU 淘汰。
  - 云端：单一通用 **OpenAI-兼容** provider，接 OpenAI / OpenRouter / vLLM 等。
- **Agent 内核 = pi-coding-agent（托管）**
  - 内核为托管 [`@earendil-works/pi`](https://github.com/earendil-works/pi) 的 `AgentSession`（无头嵌入）：自带编码工具（read/bash/edit/write/grep/ls/find）、自动上下文 compaction、会话管理。EasyWork 是它的宿主/集成层。
  - **真实工具审批流（4 档）**：`read-only` / `approve-each` / `auto-edits` / `full-auto`，经 pi `tool_call` 钩子映射；危险工具经 SSE 挂起，UI 弹窗「允许 / 总是允许 / 拒绝」。
  - **工作区路径限定**：fs 工具路径经 realpath 解析后硬拦越界（含软链接），bash 由审批把守。
  - 内置工具（桥成 pi customTool）：`get_time` / `calculator` / `http_get`（带 SSRF 防护）/ `web_search`。
  - **记忆/知识库/会话检索**：记忆经 pi 扩展接入——**渐进式披露**（记忆「清单」注入系统提示词 + `recall_memory` 工具按需取全文，借鉴 Skill）+ **批量事实抽取**（空闲/关闭时，非每轮）；知识库 / 会话检索为 customTools。
  - **MCP**：stdio（默认禁用，需开关）+ HTTP；工具桥成 pi customTools；导入标准 `mcpServers` JSON。
  - **Skills**：pi 自带 skills（resourceLoader 发现）+ 应用内 Skills 管理。
- **工作区模式**：在本地项目目录里读写文件 / 跑命令（git 改动审阅面板）。聊天模式也能写文件 / 跑命令，但**限定在每会话工件目录内**，右侧「工件」面板实时展示产出（网页 / 文件等）。
- **文档知识库 RAG**：本地文件上传 → 异步解析（带进度）→ 分块 → 嵌入 → **RRF 混合检索**（sqlite-vec 语义 + 词法）→ 多集合作用域 → 首轮自动注入 + 引用来源。
- **可插拔记忆（作用域化）**：**全局池**（所有对话共享）+ **每工作区私有池**（互相隔离、独立于全局，工作区盯约定 / 变动 / 坑）；**渐进式披露**注入（清单常驻 + 按需取全文）+ **批量抽取**（非每轮）；**sqlite-vec ⊕ 词法**混合召回；全局 markdown 可手改回灌；记忆页按作用域浏览 / 编辑 / 清空；Mem0 适配器。
- **采样参数**：`temperature / top_p / top_k / min_p / repeat_penalty / frequency_penalty / presence_penalty / reasoning_effort`，全链路透传，**按模型**保存（聊天内快捷浮层）。
- **多协议端点（网关）**：`/v1/chat/completions`（+stream）、`/v1/embeddings`、`/v1/models`（OpenAI 兼容）、`/v1/messages`（Anthropic 兼容）。本地模型**透传**到其 llama-server 原生端点（OpenAI + 原生 Anthropic）；云端**流式经 pi-ai**（统一鉴权，含 OAuth）。可让 Claude Code 等外部客户端直接指向。
- **本地端口暴露**：llama-server 默认仅绑 `127.0.0.1`；可在「设置 → 本地网络」切到 `0.0.0.0` 让局域网其他服务直连（**强制设置 api-key**，未鉴权拒绝）。
- **思维链**：`<think>` 与 gpt-oss harmony 多通道（analysis → 思考 / final → 正文）解析。
- **桌面 UI**：聊天（流式 / 思维链 / 工具卡 / 引用 / HTML 工件 / 图片多模态 / 审批弹窗 / 右侧「工件」面板）、模型、知识库、Skills、MCP、记忆（按作用域）、设置 —— 各为独立页面。

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
npm test               # vitest（196 测试）
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

## 📍 路线 / 未完成

- IM 连接器：Telegram 已实现；Discord / 企业微信 / 飞书规划中。
- 命令执行：工作区模式经 pi 的 `bash` 工具执行，由审批 4 档把守（非 `full-auto` 需确认）；无独立 OS 级沙箱。
- 持久化以 `ConversationRepo` 为真相源（未切 pi `SessionManager`）。
- 个人微信无官方机器人 API → 仅做企业微信。

进展详见 [`docs/PROGRESS.md`](docs/PROGRESS.md)，约定与架构详见 [`CLAUDE.md`](CLAUDE.md)。

---

## 📄 许可

私有项目。能力思路参考 Unsloth Studio（AGPL-3.0）与 Hermes Studio，但为独立实现，不复制其代码。
