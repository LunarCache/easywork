# 知识库页面重设计

> **历史快照（2026-06-24）**：本文记录当时的设计决策，不作为当前 UI、技术栈或完成状态的权威来源。当前状态请以 [`docs/FEATURES.md`](../../FEATURES.md)、[`docs/ARCHITECTURE.md`](../../ARCHITECTURE.md) 与 [`docs/PROGRESS.md`](../../PROGRESS.md) 为准。

> 把桌面端「插件 → 知识库」从「单列手风琴 + 滑出预览」重构为「左集合栏 + 右文档卡片网格」。解决信息架构不直观的问题（核心痛点：手风琴需反复展开/折叠，文档不能一眼平铺）。

## 背景

当前 `KnowledgeBaseOverlay`（`apps/ui/src/components/KnowledgeBaseOverlay.tsx`）经多次迭代已从「三栏」改为「单列集合手风琴 + 右侧滑出预览」，但用户反馈信息架构仍不直观：集合默认折叠，要逐个展开才能看到文档；滑出预览遮挡列表。

经 brainstorming（核心痛点 = 布局/信息架构；选 B 方向「左集合 + 右文档卡片网格」；确认要集合搜索框，搜索采用前端筛选），本设计把右侧改为**响应式卡片网格**，每张卡片承载类型角标 + 名称 + 元信息。

## 目标 / 非目标

**目标**
- 左集合栏常驻 + 右文档卡片网格，所有文档一眼平铺，切换集合即换内容。
- 文档区内置前端搜索框（按文件名即时过滤）。
- 复用现有滑出预览（md 渲染 / 纯文本 / 放大）、上传、新建集合、处理中轮询、删除。

**非目标**
- 不改后端检索算法（RAG retrieve 语义搜索）——那是对话里 `search_knowledge_base` 工具的活。
- 不改上传/解析/嵌入流水线。
- 不动其他插件页（模型/Skills/MCP/记忆）。

## 信息架构

```
┌─ 头部 ────────────────────────────────────────────────────────────────┐
│ 📚 知识库 · "128 片段已索引 · 1 处理中"          [＋新建集合] [⬆上传] │
├───────────────┬──────────────────────────────────────────────────────┤
│ 集合 (210px)   │  DOCS · 6 文档              [🔍 搜索本集合…]          │
│               ├──────────────────────────────────────────────────────┤
│ ● default  4   │  ┌────────┐ ┌────────┐ ┌────────┐                   │
│ ◉ docs     6   │  │MD name │ │PDF name│ │TXT name│  ← 响应式网格      │
│ ○ research 2   │  │14片·3h │ │6片·2d  │ │3片·5d  │  auto-fill 220px │
│ ○ code-snps 1  │  └────────┘ └────────┘ └────────┘                   │
│               │  点任意卡片 → 右侧滑出全文预览（复用现有 kb-pv）       │
└───────────────┴──────────────────────────────────────────────────────┘
```

**与当前的关键差异**
- 旧：单列手风琴，集合折叠态只看计数，展开才见文档。
- 新：左右双栏，左侧选集合，右侧文档以卡片网格平铺，无需展开/折叠。
- **去掉「全部文档」入口**：集合是唯一组织维度；默认选中第一个集合（无集合则空态）。

## 组件拆解

### ① 集合栏（左侧，width 210px）
常驻列表，每行 = 主导类型图标 + 集合名 + 文档数。
- 主导类型 = `dominantType(docs.map(d=>d.source))`（集合内最多扩展名对应的角标，空集合回退中性 `KbIcon`）。**复用现有逻辑，零改动。**
- 处理中的集合带脉冲点（`kb-acc-proc` 的 `spin`/pulse 样式迁移到集合行）。
- 点击切换右侧文档区，`on` 态用 `accent-soft`。
- 集合全集 = 后端集合 ∪ 本地新建 `extraKbs` ∪ 有处理中任务的集合（`activeJobs.kbId`）。**复用现有 `collIds` 逻辑。**

### ② 文档卡片网格（右侧主区）
响应式 `grid-template-columns: repeat(auto-fill, minmax(220px, 1fr))`，`gap: 10px`，`align-content: start`。

每张卡片：
- **顶部**：类型角标（`fileBadge(d.source)`，30×30 圆角）+ 文件名（hover 显删除按钮 `TrashIcon`）
- **元信息**：片段数 · 相对时间（`relTime`），`tx-2` 色 mono 10.5px
- 点击卡片 → `openDoc(d.id)` → 右侧滑出全文预览
- `on` 态（当前预览中）：`acc-bd` 边 + `acc-soft` 底
- hover：`border-strong` + `translateY(-1px)`

**处理中卡片**（来自 `activeJobs`）：虚线 `acc-bd` 边 + 进度条（`kb-chunks` 无进度时为不确定态）+ "嵌入中 7/12"。

**空集合**：网格区显示空态（`BookIcon` + "空集合 · 上传文档到此"）。
**无集合**：整页空态（"还没有集合 · 点上传导入 / 新建"）。

### ③ 搜索框（文档区头部右侧）
纯前端筛选，输入即过滤。
- 过滤字段：`d.source`（文件名），大小写不敏感
- 过滤后网格只显示命中卡片；空结果显示 "没有匹配的文档"
- 切换集合时清空搜索词
- `width: 160px`，`bg-elev` + `border` + 圆角，内含 `🔍` + `<input>`

### ④ 头部（顶部）
保留现有结构，微调：
- 标题副文案动态显示 "N 片段已索引 · M 处理中"（`totalChunks` + `activeJobs.length`）
- 「新建集合」按钮（行内输入，Enter 确认/Esc 取消，规范化逻辑不变）
- 「上传」按钮，title 标明目标集合 `上传到「${selectedKb || 'default'}」`

### ⑤ 滑出预览（复用，零改动）
右侧 `kb-pv` 滑出面板完全保留：返回/放大/关闭按钮、md 渲染（`react-markdown` + `remarkGfm` + `rehypeHighlight`）/纯文本 `<pre>`、`maxed` 放大铺满。仅 CSS 定位从 `kb-acc-body` 内调整为新布局的右侧。

## 数据流

### 后端：零改动

现有 `listDocs()` 已返回 `{ id, kbId, source, chunks, createdAt }`，足够支撑卡片网格（角标 + 文件名 + 片段数 + 时间）与文件名搜索。`/kb/docs` 路由、SDK `kbDocs()` 均无需改动。

### 前端数据流（最小改动）

```ts
const [allDocs, setAllDocs] = useState<KbDoc[]>([]);  // 已存在
const [selectedKb, setSelectedKb] = useState<string | undefined>(undefined);
const [q, setQ] = useState("");

// refresh 一次取全部文档（已存在）
const [list, all] = await Promise.all([getClient().kbList(), getClient().kbDocs()]);

// 当前集合文档
const collDocs = allDocs.filter((d) => d.kbId === selectedKb);
// 前端搜索过滤（仅文件名）
const filtered = q.trim()
  ? collDocs.filter((d) => d.source.toLowerCase().includes(q.trim().toLowerCase()))
  : collDocs;
```

### 零改动部分
后端（store/route/SDK）、滑出预览、上传（`onFiles`）、新建集合（`confirmColl`）、处理中轮询（`useEffect` + `setInterval`）、删除（`del`）——逻辑全部保留，仅 JSX 结构和 CSS 重排。

## 视觉规范（贴合现有 Agent Tasks token）

| 元素 | 规范 |
|---|---|
| 卡片底 | `bg-elev` (#16181E) + `border` (#23262F) + `r-lg` 12px |
| 卡片 hover | `border-strong` + `translateY(-1px)` |
| 卡片选中 | `acc-bd` 边 + `acc-soft` 底 |
| 处理中卡片 | 虚线 `acc-bd` + 进度条 |
| 角标/图标 | 复用 `lib/filetype.ts`（`fileType()` → label/color/Icon） |
| 集合行 | 复用 `dominantType` + pulse 处理中点 |
| 搜索框 | `bg-elev` + `border` + 28px 高 + 160px 宽 |

## 受影响文件

| 文件 | 改动 |
|---|---|
| `apps/ui/src/components/KnowledgeBaseOverlay.tsx` | 重构 JSX：手风琴 → 左集合栏 + 右卡片网格；加搜索框 + 前端过滤（仅文件名） |
| `apps/ui/src/styles.css` | 删 `.kb-acc-*` 手风琴样式；新增 `.kb-coll-*`（集合栏）/`.kb-doc-grid`/`.kb-doc-card`（网格）/`.kb-search`；调整 `.kb-pv` 定位 |

## 验收标准

1. 左集合栏常驻，点击切换右侧文档区，处理中集合有脉冲点。
2. 右侧文档以响应式卡片网格平铺，每张卡片显示角标 + 名称 + 片段数·时间。
3. 搜索框输入即过滤（文件名），空结果显示提示，切集合清空搜索词。
4. 点卡片滑出全文预览（md 渲染 / 纯文本 / 放大），与现状行为一致。
5. 上传 / 新建集合 / 删除 / 处理中轮询功能不回归。
6. `npm run typecheck`（19/19）+ `npm run lint`（0 error）+ UI `npm run build` 绿。
7. 后端零改动；既有测试全绿（`npm test`）。

## 风险 / 边界

- **纯前端改动**：后端零改动，无回归风险；既有 KB 测试不受影响。
- **空文件名/长文件名**：卡片名溢出用 `text-overflow: ellipsis` 处理。
