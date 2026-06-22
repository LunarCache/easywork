<div align="center">

<img src="apps/desktop/src-tauri/icons/128x128@2x.png" width="92" alt="EasyWork" />

# EasyWork · 本地 AI 工作台

纯推理（无训练 / 微调）的跨平台本地 AI 工作台

**本地 GGUF / 云端 OpenAI-兼容模型** · **Agent 工具**（内置 / Skills / MCP）· **知识库 RAG** · **可插拔记忆** · 应用内聊天 + 外部 IM

TypeScript 全栈 · Linux / macOS / Windows · Agent 内核 = 托管 [pi-coding-agent](https://github.com/earendil-works/pi)

```bash
curl -LsSf https://raw.githubusercontent.com/LunarCache/easywork/main/install.sh | sh
```

</div>

---

## 概览

- **本地 / 云端模型**：HuggingFace 搜索 + 断点续传下载 GGUF，经统一 `llama` 的 **router 模式**运行（单 `llama serve --models-dir` 进程，按 model 路由 + 按需加载 + LRU；文本 / 视觉）；或接任意 OpenAI-兼容 provider。
- **Agent 内核**：托管 [pi-coding-agent](https://github.com/earendil-works/pi)，自带编码工具 + 自动 compaction；4 档工具审批 + 工作区路径限定；内置工具 / Skills / MCP。
- **工作区 + 聊天**：本地项目目录读写文件 / 跑命令（git 审查），或隔离的每会话工件目录；右侧统一「工作台坞」（改动 / 文件 / 终端 / 预览）。
- **知识库 RAG + 可插拔记忆**：sqlite-vec 语义 ⊕ 词法混合召回；记忆作用域化 + 渐进式披露 + 批量抽取。
- **多协议网关**：`/v1`（OpenAI）+ `/v1/messages`（Anthropic），可让 Claude Code 等外部客户端直接指向。
- **桌面 UI**：Tauri 2 + React 的 Agent Desk 工作台（明暗 + 三色 accent + 密度）。

> 详见 [功能与设计 →](docs/FEATURES.md)

---

## 安装（macOS · Apple Silicon）

```bash
curl -LsSf https://raw.githubusercontent.com/LunarCache/easywork/main/install.sh | sh
```

从[公开 Releases](https://github.com/LunarCache/easywork/releases) 下载 dmg 装到 `/Applications`。**安装包内置单文件 daemon（Node SEA），运行无需 Node**；脚本装完会**自动检测并备齐本地推理运行时**（缺失则经 [llama.app](https://llama.app) 安装）。

> 初版**未签名**（ad-hoc）：`curl|sh` 安装无感；若手动下载 dmg 遇 Gatekeeper 提示，「系统设置 → 隐私与安全性 → 仍要打开」或 `xattr -dr com.apple.quarantine /Applications/EasyWork.app`。Intel / Windows / Linux 后续支持。

---

## 命令行（CLI）

安装后 `easywork` 既是 daemon 入口，也是终端客户端 —— 无 GUI（SSH / 服务器）也能用，可脚本化。首次用会**自动在后台拉起本机 daemon**（读 `~/.easywork/daemon.json` 探活，没活就起一个）。

```bash
easywork                       # 交互式 REPL（默认）：多轮对话 + 工具审批 y/n（Ctrl-C 中断本轮）
easywork run "总结这个仓库"      # 一次性问答，流式输出后退出
cat error.log | easywork run "分析这段日志"     # 管道：stdin 作提问，stdout 只出回复
easywork run "重构 utils.ts" -w . -y           # 在当前目录跑 agent，自动批准工具
easywork run "继续" -t <threadId>              # 续接已有会话（repl 同样支持 -t）

easywork models                # 列出已路由 + 本地模型
easywork models pull <hf-repo> # 下载 GGUF（--quant Q4_K_M 指定量化）
easywork models rm <名/片段>    # 删除本地模型（受管目录硬校验，先卸载再删）
easywork thread ls / show <id> / rm <id>       # 会话历史浏览 / 查看 / 删除
easywork mem ls / search <词> / rm <id>        # 记忆列表 / 召回 / 删除
easywork kb  ls / search <词> / add <文件> / rm <docId>   # 知识库
easywork status / stop         # daemon 状态 / 停止
```

选项：`-m/--model`、`-w/--workspace <dir>`、`-t/--thread <id>`、`-y/--yes`（自动批准 / 跳过删除确认）。环境：`EW_BASEURL`/`EW_TOKEN` 直连远端 daemon，`EW_MODEL` 默认模型。完整用法见 `easywork --help`。

---

## 从源码开发

环境：**Node ≥ 24**（内置 `node:sqlite`；推荐 26）、npm 11、统一 **`llama`**（llama.app，router 模式必需：`curl -LsSf https://llama.app/install.sh | sh` / `irm https://llama.app/install.ps1 | iex`）。桌面需 Rust（`cargo`）。Windows 另需 Git（见 [平台说明](docs/ARCHITECTURE.md#平台说明)）。

```bash
npm install            # 安装依赖
npm run build          # turbo 构建全部包
npm test               # vitest（204 测试）  ·  npm run typecheck  ·  npm run lint

npm run dev:daemon     # 仅起 daemon（stdout 首行打印 {baseUrl, token, pid}）
npm run dev:ui         # 起 Vite；浏览器连 daemon：http://localhost:5173/?baseUrl=<daemon>&token=<token>
npm run dev:desktop    # tauri dev：Rust 壳 + Vite + daemon sidecar

node scripts/build-daemon-sea.mjs          # daemon → 单文件二进制（Node SEA）
npm run app:build --workspace @ew/desktop  # 出 macOS dmg + .app
```

> 发布：打 `v*` tag 触发 [`release.yml`](.github/workflows/release.yml)，macOS runner 构建 dmg 并发到 Releases。

---

## 文档

| 文档 | 内容 |
|---|---|
| [docs/FEATURES.md](docs/FEATURES.md) | 功能与设计详解（模型 / Agent / 记忆 / RAG / UI / `/v1` 端点） |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 架构（Core Daemon 模型）/ Monorepo / 技术栈 / 环境变量 / 平台说明 |
| [docs/PROGRESS.md](docs/PROGRESS.md) | 状态总览（已完成 / 待做）+ 里程碑日志 |
| [CLAUDE.md](CLAUDE.md) | 开发约定与关键正确性约束（权威来源） |

---

## 许可

[MIT](LICENSE) © 2026 LunarCache
