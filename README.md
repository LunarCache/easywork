<div align="center">

<img src="apps/desktop/src-tauri/icons/128x128@2x.png" width="96" alt="EasyWork" />

# EasyWork

### 本地优先的 AI 工作台，把模型、记忆、工具、知识库和外部渠道收进同一个大脑。

[![CI](https://github.com/LunarCache/easywork/actions/workflows/ci.yml/badge.svg)](https://github.com/LunarCache/easywork/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/LunarCache/easywork?sort=semver)](https://github.com/LunarCache/easywork/releases)
[![License](https://img.shields.io/github/license/LunarCache/easywork)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D24-3c873a)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)](tsconfig.base.json)
[![Tauri](https://img.shields.io/badge/Tauri-2.x-24c8db)](apps/desktop/src-tauri/tauri.conf.json)

**本地 GGUF / 云端模型** · **pi Agent 内核** · **Skills / MCP / 内置工具** · **知识库 RAG** · **作用域化记忆** · **桌面 + CLI + `/v1` 网关** · **Telegram / Feishu / Lark / WeChat 渠道**

```bash
curl -LsSf https://raw.githubusercontent.com/LunarCache/easywork/main/install.sh | sh
```

</div>

---

## 为什么是 EasyWork

EasyWork 不是一个只包了聊天框的客户端。它的核心是一个本地守护进程：同一个 daemon 托管 agent 会话、模型路由、工具审批、记忆、知识库、外部渠道连接器和 OpenAI/Anthropic 兼容网关。桌面、命令行、IM 连接器和任意 `/v1` 客户端都只是它的瘦客户端。

| 能力 | 说明 |
|---|---|
| **本地优先** | 本地 GGUF 通过统一 `llama serve --models-dir` router 运行，按需加载、多模型路由、LRU 淘汰；云端模型可接 OpenAI / OpenRouter / DeepSeek / vLLM 等 provider。 |
| **真正的 Agent** | 托管 [`pi-coding-agent`](https://github.com/earendil-works/pi) 的 `AgentSession`，自带 read/bash/edit/write/grep/ls/find、上下文压缩、会话管理。 |
| **可审计工具流** | 4 档审批策略、工作区路径硬隔离、行内工具调用、git 改动审阅、终端和文件预览都在同一个工作台内。 |
| **记得住，也查得到** | 作用域化记忆 + sqlite-vec 语义召回 + 词法兜底；知识库文档支持解析、分块、检索和引用。 |
| **多入口一个大脑** | Tauri 桌面、CLI、Telegram / Feishu / Lark / WeChat 收件箱、OpenAI `/v1` 与 Anthropic `/v1/messages` 共享同一套后端能力；渠道生命周期由 core 侧 Channel Operations 统一管理。 |

---

## 架构一览

```mermaid
flowchart LR
  Desktop["Tauri Desktop"]
  CLI["easywork CLI"]
  IM["Channel Connectors"]
  V1["/v1 Clients"]

  Core["Core Daemon<br/>Fastify + SSE + SQLite"]
  Agent["pi AgentSession"]
  Router["llama router<br/>local GGUF"]
  Cloud["Cloud Providers"]
  Tools["Built-in Tools<br/>Skills<br/>MCP"]
  Memory["Memory + KB<br/>sqlite-vec"]

  Desktop --> Core
  CLI --> Core
  IM --> Core
  V1 --> Core
  Core --> Agent
  Core --> Router
  Core --> Cloud
  Core --> Tools
  Core --> Memory
```

核心原则很简单：**daemon 拥有全部状态和能力，所有界面都是薄壳**。这让桌面聊天、工作区 agent、外部渠道消息和命令行自动化能复用同一份上下文、权限、记忆和模型配置。

---

## 功能地图

### Agent 工作台

- 对话模式：适合问答、总结、联网搜索、知识库检索和多模态输入。
- 工作区模式：在本地项目目录内读写文件、运行命令、查看 git diff、预览文件和终端输出。
- 右侧工作台坞：改动、文件、终端、预览和上下文状态常驻可见。
- 行内工具调用：思考、探索、编辑、运行、web search 等过程结构化展示。

### 模型与网关

- 本地模型：HuggingFace 搜索、断点续传下载、GGUF 元数据解析、统一 llama router 运行，并可在模型页按模型配置默认运行采样参数。
- 云端 provider：支持常见 OpenAI-compatible 端点，内置 provider 配置契约和模型目录。
- 多协议 API：OpenAI `/v1/chat/completions`、`/v1/embeddings`、`/v1/models`，以及 Anthropic `/v1/messages`。

### 记忆、知识库、Skills、MCP

- 记忆按全局 / 工作区作用域隔离，支持语义召回、词法召回和 markdown 真相源回灌。
- 知识库支持上传、解析、分块、混合检索和引用来源。
- Skills 页面只展示全局技能来源：内置 `~/.easywork/pi-agent/skills` 与标准 `~/.agents/skills`。
- MCP 支持 stdio 与 HTTP，工具清单探测、启停、导入和审批一体化。

### 外部渠道

- Channel Gateway 把不同平台统一成 adapter；core 侧 Channel Operations 统一管理连接器生命周期、扫码连接会话、收件箱读模型和 SSE 失效事件。
- Telegram long-poll、Feishu/Lark WebSocket 与 webhook、WeChat iLink QR + long-poll 已落地。
- 收件箱按外部联系人聚合消息，使用 SSE invalidation 实时刷新。

---

## 安装

### macOS Apple Silicon

```bash
curl -LsSf https://raw.githubusercontent.com/LunarCache/easywork/main/install.sh | sh
```

也可以从 [Releases](https://github.com/LunarCache/easywork/releases) 下载 dmg 装到 `/Applications`。

安装包内置单文件 daemon（Node SEA），运行无需系统 Node。首次启动会检测本地推理运行时；缺失时通过 [llama.app](https://llama.app) 安装统一 `llama`。

> 当前 macOS 包为 ad-hoc 未签名版本。若手动下载 dmg 遇到 Gatekeeper 提示，可在「系统设置 -> 隐私与安全性」选择仍要打开，或执行 `xattr -dr com.apple.quarantine /Applications/EasyWork.app`。

### 其他平台

Intel Mac、Windows、Linux 安装包仍在后续发布计划中。源码开发已按跨平台路径设计，Windows 需要额外安装 Git。

---

## CLI

安装后 `easywork` 同时是 daemon 入口和终端客户端。它会自动发现或拉起本机 daemon，适合 SSH、脚本化任务和无 GUI 场景。

```bash
easywork                                      # 交互式 REPL
easywork run "总结这个仓库"                    # 一次性问答
cat error.log | easywork run "分析这段日志"    # stdin 作为提问
easywork run "重构 utils.ts" -w . -y          # 在当前目录运行 agent 并自动批准
easywork run "继续" -t <threadId>             # 续接已有会话

easywork models                              # 列出已路由和本地模型
easywork models pull <hf-repo>               # 下载 GGUF
easywork models rm <name>                    # 删除本地模型
easywork thread ls / show <id> / rm <id>     # 会话历史
easywork mem ls / search <query> / rm <id>   # 记忆
easywork kb ls / search <query> / add <file> # 知识库
easywork status / stop                       # daemon 状态 / 停止
```

常用选项：`-m/--model`、`-w/--workspace <dir>`、`-t/--thread <id>`、`-y/--yes`。

常用环境变量：`EW_BASEURL`、`EW_TOKEN`、`EW_MODEL`。

---

## 从源码开发

### 环境要求

| 依赖 | 说明 |
|---|---|
| Node.js | `>=24`，推荐 Node 26；依赖内置 `node:sqlite`。 |
| npm | 项目统一使用 npm，不使用 pnpm。 |
| Rust | 构建 Tauri 桌面壳需要 `cargo`。 |
| llama | 本地推理统一使用 llama.app 的 `llama`，router 模式必需。 |
| Git | Windows 平台需要额外安装。 |

安装 llama：

```bash
curl -LsSf https://llama.app/install.sh | sh
```

### 常用命令

```bash
npm install
npm run build
npm run lint
npm run typecheck
npm test               # vitest: 296 passed / 1 skipped
npm run test:coverage

npm run e2e:install
npm run test:e2e       # Playwright UI e2e: 22 条，真 daemon + 真 Vite + 隔离 data dir

npm run dev:daemon     # 仅启动 daemon，首行输出 {baseUrl, token, pid}
npm run dev:ui         # 仅启动 Vite
npm run dev:desktop    # Tauri dev: Rust 壳 + Vite + daemon sidecar
```

构建发布产物：

```bash
node scripts/build-daemon-sea.mjs
npm run app:build --workspace @ew/desktop
```

发布流程：推送 `v*` tag 触发 [`release.yml`](.github/workflows/release.yml)，macOS Apple Silicon runner 构建 dmg 并上传到 GitHub Releases。

---

## 测试覆盖

- Vitest：296 passed / 1 skipped。
- Playwright UI e2e：22 条，覆盖设置页、模型模板跨协议元数据继承、推理模型默认思考档位、渠道/知识库/Skills/MCP/记忆入口、Chat / Workspace composer、联网工具门控、图片上传与粘贴、搜索导航、文件页、记忆 CRUD、知识库、Skills 模板与详情。
- 真机 runtime smoke：`EW_E2E=1 npx vitest run packages/core/test/session-host.e2e.test.ts`，依赖本地 `llama` 与真实 GGUF，默认不进 CI。

---

## 文档入口

| 文档 | 内容 |
|---|---|
| [docs/DESIGN.md](docs/DESIGN.md) | 系统设计与功能详解：架构、子系统原理、关键数据流和设计取舍。 |
| [docs/FEATURES.md](docs/FEATURES.md) | 功能说明：模型、Agent、记忆、RAG、UI、`/v1` 端点。 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Core daemon、monorepo、技术栈、环境变量和平台说明。 |
| [docs/PROGRESS.md](docs/PROGRESS.md) | 状态总览与倒序里程碑日志。 |
| [AGENTS.md](AGENTS.md) | 开发约定、关键正确性约束和常用命令。 |

---

## 许可证

[MIT](LICENSE) © 2026 LunarCache
