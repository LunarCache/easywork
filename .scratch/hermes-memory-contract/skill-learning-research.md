# Hermes 自动学习与可复用 Skill 提取调研

调研日期：2026-07-12

基线：Hermes Agent 最新发布版 [v0.18.2 / v2026.7.7.2](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.7.7.2)，并用该 tag 的官方文档和源码交叉核对。除最后的“提案边界”外，不使用 issue 中的设想描述当前能力。

## 结论

Hermes 当前确实具有自动学习并生成、修订 Skill 的闭环，但“自动提取”不是确定性抽取器，也不是训练或微调：它是一个由计数阈值触发的后台 LLM 复盘 Agent，复读当前对话，判断是否需要调用 `skill_manage` 创建或修改文件。另有用户显式触发的 `/learn`，它同样只是给当前 Agent 注入一段严格的创作提示，再由 Agent 调研来源并写出 Skill。

因此可以把 Hermes 的能力拆成四层：

1. 前台 Agent 持续收到“复杂任务后保存方法、发现 Skill 过时就立即修订”的系统提示。
2. `/learn` 把指定目录、网页、粘贴内容或刚完成的流程显式蒸馏为 Skill。
3. 后台 self-improvement review 定期复盘对话，自动创建或修订 Skill。
4. Curator 根据使用情况把自动产生的 Skill 标记为 stale、归档，必要时合并为更宽的 umbrella Skill。

## 1. 前台主动学习

Hermes 的常驻系统提示要求 Agent 在复杂任务、棘手错误或非平凡工作流完成后调用 `skill_manage` 保存方法；如果使用中的 Skill 错误、缺步骤或过时，应立即 `patch`。[源码：`SKILLS_GUIDANCE`](https://github.com/NousResearch/hermes-agent/blob/v2026.7.7.2/agent/prompt_builder.py#L176-L182)

官方文档把适合形成 Skill 的信号归纳为：复杂任务成功、克服错误或死路、用户纠正了方法、发现非平凡工作流。Skill 被定义为 procedural memory，而短小事实属于 memory。[官方 Skills 文档](https://github.com/NousResearch/hermes-agent/blob/v2026.7.7.2/website/docs/user-guide/features/skills.md#L434-L460)

这一层是“鼓励模型主动调用工具”，不是独立后台抽取。工具描述还要求前台 Agent 在创建或删除 Skill 前向用户确认；后台复盘则有独立来源标记和审批策略。[`skill_manage` 工具定义](https://github.com/NousResearch/hermes-agent/blob/v2026.7.7.2/tools/skill_manager_tool.py#L1426-L1472)

## 2. 显式 `/learn`

`/learn` 可接收：

- 本地文件或目录；
- 在线文档 URL；
- 当前对话中刚走过的工作流；
- 用户粘贴的笔记或流程描述。

它没有独立 ingestion/distillation 服务，也没有专用模型工具：命令构造一段 authoring prompt，作为普通用户轮次交给当前 Agent；Agent 用现有文件/网页工具获取材料，再用 `skill_manage(action="create")` 写一个 Skill。[官方 `/learn` 文档](https://github.com/NousResearch/hermes-agent/blob/v2026.7.7.2/website/docs/user-guide/features/skills.md#L96-L128)；[提示词实现](https://github.com/NousResearch/hermes-agent/blob/v2026.7.7.2/agent/learn_prompt.py#L1-L21)

作者提示词要求 Skill 具备规范化 frontmatter，并按 `When to Use`、`Prerequisites`、`How to Run`、`Quick Reference`、`Procedure`、`Pitfalls`、`Verification` 等结构组织；复杂脚本放入 `scripts/`，资料放入 `references/`，模板放入 `templates/`，不能发明未在来源中出现的命令或 API。[`/learn` authoring standards](https://github.com/NousResearch/hermes-agent/blob/v2026.7.7.2/agent/learn_prompt.py#L24-L97)

这是用户显式的 Skill 创作入口，不应与后台“自动发现候选”混为一谈。

## 3. 后台自动复盘

### 触发

默认配置为：

- memory：每 10 个用户轮次触发一次；
- skills：每累计 10 个 Agent/tool-loop iteration 触发一次；调用 `skill_manage` 会重置 Skill 计数。

默认值来自 [`agent_init.py`](https://github.com/NousResearch/hermes-agent/blob/v2026.7.7.2/agent/agent_init.py#L1326-L1345) 和 [`creation_nudge_interval`](https://github.com/NousResearch/hermes-agent/blob/v2026.7.7.2/agent/agent_init.py#L1422-L1428)。memory 在轮次开始累计，[`turn_context.py`](https://github.com/NousResearch/hermes-agent/blob/v2026.7.7.2/agent/turn_context.py#L303-L314)；Skill 在 Agent 循环中累计，并在结束阶段判断阈值。复盘只在本轮有正常最终回复且未被中断时启动，失败被视为 best-effort，不影响主任务。[`turn_finalizer.py`](https://github.com/NousResearch/hermes-agent/blob/v2026.7.7.2/agent/turn_finalizer.py#L454-L480)

当前发布版内置记忆没有 EasyWork 式 `flush_min_turns + 固定 JSON fact extractor`。这里的“nudge”本质上是一次 LLM 反思；memory 与 Skill 阈值同时到达时，会用组合提示词一起判断。

### 复盘判断与写入策略

Skill review 提示词要求寻找：

- 用户对风格、格式、工作流或步骤的纠正；
- 非平凡技术、修复、绕路、调试路径或工具模式；
- 本次加载/查看的 Skill 中暴露的错误、缺失或过时内容。

写入优先级是：

1. `patch` 本轮实际加载过的 Skill；
2. 查找并修改已有 class-level umbrella Skill；
3. 给 umbrella 增加 `references/`、`templates/` 或 `scripts/` 支持文件；
4. 没有合适归属时，才创建新的 class-level umbrella Skill。

它明确排除 PR 号、单个错误字符串、当日任务、临时环境故障、短暂失败和“一次一 Skill”的会话碎片，并允许输出 `Nothing to save.`。[完整 Skill review prompt](https://github.com/NousResearch/hermes-agent/blob/v2026.7.7.2/agent/background_review.py#L171-L274)

需要注意，提示词同时使用了强烈的“Be ACTIVE / most sessions produce at least one update”措辞。这会提高召回率，也会增加错误归类、过度学习和库膨胀风险；这是应借鉴机制、但不应照抄的部分。

### 与主会话隔离

复盘在 daemon thread 中创建独立 `AIAgent`，默认复用主模型和已热缓存的系统提示；也可配置便宜的 `auxiliary.background_review` 模型。它关闭自身记忆 nudge、Skill nudge、压缩和会话持久化，避免把“review conversation”提示写进用户真实历史；运行时只允许 memory/skills 工具，其他工具会被拒绝。[后台 fork 与持久化隔离](https://github.com/NousResearch/hermes-agent/blob/v2026.7.7.2/agent/background_review.py#L638-L776)；[工具白名单](https://github.com/NousResearch/hermes-agent/blob/v2026.7.7.2/agent/background_review.py#L778-L825)

同模型时复放完整历史以利用 prompt cache；路由到其他模型时，复放“旧轮次摘要 + 最近轮次原文”的 digest。这是成本优化，不改变其 LLM 复盘性质。

## 4. Skill 产物与运行方式

所有本地、Hub 安装和 Agent 创建的 Skill 都进入 `~/.hermes/skills/`；`SKILL.md` 是必需入口，可附带 `references/`、`templates/`、`scripts/`、`examples/`、`assets/`。Skill 通过三级 progressive disclosure 暴露：先索引名称/描述，需要时再读取完整 `SKILL.md` 或单个支持文件。[格式和 progressive disclosure](https://github.com/NousResearch/hermes-agent/blob/v2026.7.7.2/website/docs/user-guide/features/skills.md#L130-L180)

`skill_manage` 支持 `create`、`patch`、`edit`、`delete`、`write_file`、`remove_file`；写入会校验名称、frontmatter、内容长度、允许的支持目录和路径逃逸，并使用原子写入。[工具实现](https://github.com/NousResearch/hermes-agent/blob/v2026.7.7.2/tools/skill_manager_tool.py#L470-L590)

自动复盘在修改已有 Skill 前还必须先用 `skill_view` 读取目标；后台自动维护禁止修改 pinned、external、bundled 和 hub-installed Skill，只能操作本地自动沉淀内容。[后台所有权与 read-before-write guard](https://github.com/NousResearch/hermes-agent/blob/v2026.7.7.2/tools/skill_manager_tool.py#L297-L410)

## 5. 审批与安全

Hermes 有两个彼此独立的开关：

- `skills.write_approval`：所有 Skill 写入先 staged，之后用 `/skills diff/approve/reject` 审核；**默认关闭**。
- `skills.guard_agent_created`：对 Agent 创建/修改的内容做危险模式扫描；**默认关闭**。

因此默认配置下，后台复盘可以直接落地 Skill，且 agent-created Skill 不经过内容扫描。Hub/URL 安装的第三方 Skill 始终走另一套安装扫描，不能据此推断自动学习 Skill 默认也被扫描。[审批文档](https://github.com/NousResearch/hermes-agent/blob/v2026.7.7.2/website/docs/user-guide/features/skills.md#L466-L501)；[扫描默认值](https://github.com/NousResearch/hermes-agent/blob/v2026.7.7.2/website/docs/user-guide/configuration.md#L584-L604)；[扫描代码](https://github.com/NousResearch/hermes-agent/blob/v2026.7.7.2/tools/skill_manager_tool.py#L93-L145)

这也是 EasyWork 不应照搬默认值的主要原因：自动 Skill 是可执行程序性资产，安全级别高于普通事实记忆。

## 6. Curator 生命周期

只有后台 self-improvement review 创建的 Skill 会被标记为 `agent-created`；前台 `/learn` 或用户要求 Agent 创建的 Skill 被视为 user-directed，不进入自动 curator 管辖。[来源标记代码](https://github.com/NousResearch/hermes-agent/blob/v2026.7.7.2/tools/skill_manager_tool.py#L1389-L1408)；[Curator 语义](https://github.com/NousResearch/hermes-agent/blob/v2026.7.7.2/website/docs/user-guide/features/curator.md#L141-L175)

Curator 默认启用，但不是常驻 cron：CLI 启动或 gateway tick 时检查，默认至少间隔 7 天且 Agent 空闲 2 小时才运行。确定性阶段把 30 天未用的 Skill 标记为 `stale`，90 天未用的移动到可恢复 archive；不会自动硬删除。LLM 合并 umbrella Skill 默认关闭，需显式开启。每次真实运行前可备份，支持 rollback、pin 和 restore。[Curator 运行与默认值](https://github.com/NousResearch/hermes-agent/blob/v2026.7.7.2/website/docs/user-guide/features/curator.md#L17-L58)

这个设计补偿了自动学习必然产生的噪声：没有使用遥测、归档和回滚，自动创建 Skill 会持续污染发现索引。

## 7. UI / Desktop 行为

Hermes Web Dashboard 的 Skills 页有 “Learn a skill” 面板，包含目录、URL、自由文本三类输入；它只负责拼装 `/learn` 并跳到 Chat，不存在单独的后端提取接口。[Dashboard 实现](https://github.com/NousResearch/hermes-agent/blob/v2026.7.7.2/web/src/pages/SkillsPage.tsx#L210-L245)

独立 Hermes Desktop v0.18.2 的 Skills 页会把 `provenance === "agent"` 标为 `learned`，允许编辑和归档本地 learned Skill；bundled/hub Skill 不开放这些操作。[Desktop 来源徽标](https://github.com/NousResearch/hermes-agent/blob/v2026.7.7.2/apps/desktop/src/app/skills/index.tsx#L101-L125)；[编辑和归档边界](https://github.com/NousResearch/hermes-agent/blob/v2026.7.7.2/apps/desktop/src/app/skills/index.tsx#L710-L740)

在该发布版 Desktop Skills 页源码中没有与旧 Web Dashboard 完全相同的 “Learn a skill” 表单；官方 Skills 文档明确描述的是 dashboard。不要把两个 UI 表面当成已经完全对齐。

## 8. 已发布能力与提案边界

已发布 v0.18.2 具备的是：前台主动提示、显式 `/learn`、阈值触发的后台 LLM review、`skill_manage` 文件写入、审批/扫描开关和 Curator 生命周期。

它**不等于**多版本 Skill 群体、fitness 评分、A/B 测试、失败驱动 mutation、自动评测后择优发布。官方仓库的 [Evolutionary Self-Improvement #337](https://github.com/NousResearch/hermes-agent/issues/337) 明确把这些列为提案，并在 “What's Missing” 中写出尚缺 population、fitness、mutation loop 和 A/B testing。该 issue 虽已关闭，但没有关联开发交付，不能当作当前产品能力。

## 9. 对 EasyWork 的可借鉴契约

建议借鉴闭环，但采用更保守的产品契约：

1. **候选优先，而非直接发布。** 后台 reviewer 产出 `SkillCandidate` 或 staged diff；用户批准后才成为可执行 Skill。默认审批开启。
2. **保留证据和来源。** Candidate 记录 `sourceThreadId`、触发轮次、证据消息/工具调用、模型和 reviewer 版本。来源对话删除时，未发布 Candidate 级联删除；已批准 Skill 独立存续，但保留可审计来源。
3. **优先修订，最后创建。** 顺序采用：本轮加载 Skill → 现有同类 Skill → 支持文件 → 新 umbrella Skill。避免“一次任务一个 Skill”。
4. **质量门槛而非强制活跃。** `Nothing to learn` 是正常结果；不要采用“多数会话都应该更新”的提示偏置。候选至少应满足：可重复触发、非临时环境、含验证步骤、来源足够、与现有 Skill 不重复。
5. **自动 reviewer 不拥有全部 Skills。** 只允许修订用户批准为“可自动演进”的本地 Skill；bundled、Hub、项目内只读 Skill 默认不可自动修改。修改前必须读取当前版本并做乐观版本校验。
6. **安全扫描默认开启。** 检查 prompt injection、凭证/隐私外泄、路径逃逸、危险命令和脚本；脚本型 Skill 还需要权限声明。审批和扫描是两道独立门。
7. **独立辅助任务。** 在主回复完成后异步运行，使用对话只读快照和有限工具集合，不写入主 thread 历史，不参与同一 thread 的 `AgentSession` 流。
8. **完整生命周期。** 跟踪 view/use/success/failure/patch；提供 active → stale → archived、pin、restore、diff 和 rollback。自动合并默认关闭。
9. **显式 Learn 入口。** UI 提供“从当前任务学习”“从目录学习”“从 URL 学习”“从文本学习”；本质上走同一个 Candidate/审批流水线，而不是另造不一致的提取后端。

最值得借鉴的不是某个 prompt，而是闭环结构：**完成任务 → 发现可复用信号 → 形成有证据的候选 → 人审/安全门 → 渐进披露使用 → 基于真实使用修订或归档**。
