# 知识库页面重设计 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把桌面端「插件 → 知识库」从「单列手风琴 + 滑出预览」重构为「左集合栏 + 右文档卡片网格 + 前端文件名搜索」。

**Architecture:** 纯前端改动（2 个文件）。后端零改动——现有 `kbDocs()` 返回的 `{ id, kbId, source, chunks, createdAt }` 已足够。`KnowledgeBaseOverlay.tsx` 的 JSX 从手风琴结构重排为双栏（左集合导航 + 右响应式卡片网格），新增前端搜索状态；`styles.css` 删除 `.kb-acc-*` 手风琴样式、新增集合栏/网格/搜索框样式。滑出预览、上传、新建集合、轮询、删除逻辑全部保留。

**Tech Stack:** React 19 + TypeScript + CSS（Agent Tasks 设计 token）。无新依赖。无后端改动。

**Spec:** `docs/superpowers/specs/2026-06-24-knowledge-base-redesign-design.md`

---

## File Structure

| 文件 | 职责 | 改动 |
|---|---|---|
| `apps/ui/src/components/KnowledgeBaseOverlay.tsx` | 知识库页面组件 | 重构 JSX 结构 + 加搜索状态 |
| `apps/ui/src/styles.css` | 全局样式 | 删 `.kb-acc-*`；新增 `.kb-coll-*`/`.kb-doc-grid`/`.kb-doc-card`/`.kb-search` |

**复用不改的现有逻辑：** `dominantType()`、`refresh()`、`onFiles()`、`del()`、`confirmColl()`、轮询 `useEffect`、滑出预览 `kb-pv`（`openDoc`/`closePreview`/`maxed`/Markdown 渲染）、`relTime()`、`fileBadge`。

**设计决策（来自 spec）：**
- 去掉「全部文档」入口；集合是唯一组织维度，默认选第一个集合。
- 卡片 = 类型角标 + 文件名 + 片段数·时间（无摘要）。
- 搜索 = 纯前端按 `source` 文件名过滤，输入即过滤，切集合清空。
- 卡片网格 `grid-template-columns: repeat(auto-fill, minmax(220px, 1fr))`。

---

## Task 1: 重构组件 JSX —— 左集合栏 + 右文档卡片网格

本任务重构 `KnowledgeBaseOverlay.tsx` 的 state 与 JSX 渲染结构。CSS 在 Task 2 处理（本任务先跑通逻辑，样式暂用旧 class 名的部分 + 临时 class，Task 2 补齐）。但为保证每步可验证，我们把 state 改动和 JSX 改动放一起，最后 typecheck。

**Files:**
- Modify: `apps/ui/src/components/KnowledgeBaseOverlay.tsx`

- [ ] **Step 1: 修改 state —— `open` 改 `selectedKb`，新增搜索 `q`**

把现有的手风琴展开状态 `open`（语义是"当前展开的集合"）改名为 `selectedKb`（语义是"当前选中的集合"），并新增搜索词状态。

在 `KnowledgeBaseOverlay.tsx` 中，找到这段 state 声明（约 98-111 行）：

```tsx
  const [allDocs, setAllDocs] = useState<KbDoc[]>([]);
  const [totalChunks, setTotalChunks] = useState(0);
  const [open, setOpen] = useState<string | undefined>(undefined); // 当前展开/上传目标集合
  const [sel, setSel] = useState<string | null>(null);
  const [content, setContent] = useState<DocContent | null>(null);
  const [maxed, setMaxed] = useState(false);
  const [jobs, setJobs] = useState<KbJob[]>([]);
  const [polling, setPolling] = useState(false);
  // 本地新建但尚无文档的集合（上传第一篇文档后由后端 kbList 接管）。
  const [extraKbs, setExtraKbs] = useState<string[]>([]);
  const [creating, setCreating] = useState(false); // 新建集合的行内输入（Tauri webview 无 window.prompt）
  const [newName, setNewName] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
```

替换为（`open`→`selectedKb`，新增 `q`/`setQ`，并让 `selectedKb` 初始指向第一个集合）：

```tsx
  const [allDocs, setAllDocs] = useState<KbDoc[]>([]);
  const [totalChunks, setTotalChunks] = useState(0);
  const [selectedKb, setSelectedKb] = useState<string | undefined>(undefined); // 当前选中/上传目标集合
  const [q, setQ] = useState(""); // 前端搜索（仅文件名）
  const [sel, setSel] = useState<string | null>(null);
  const [content, setContent] = useState<DocContent | null>(null);
  const [maxed, setMaxed] = useState(false);
  const [jobs, setJobs] = useState<KbJob[]>([]);
  const [polling, setPolling] = useState(false);
  // 本地新建但尚无文档的集合（上传第一篇文档后由后端 kbList 接管）。
  const [extraKbs, setExtraKbs] = useState<string[]>([]);
  const [creating, setCreating] = useState(false); // 新建集合的行内输入（Tauri webview 无 window.prompt）
  const [newName, setNewName] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
```

- [ ] **Step 2: 初始化默认选中第一个集合 + 搜索过滤派生数据**

在 `collIds` 计算之后（约 211 行的 `const collIds = [...]`），找到这段：

```tsx
  const activeJobs = jobs.filter((j) => ACTIVE.includes(j.status));
  // 集合全集 = 后端集合 ∪ 本地新建 ∪ 有处理中任务的集合（新集合首传时其 job 的 kbId 可能尚未进 kbs）。
  const collIds = [
    ...new Set<string>([...kbs.map((k) => k.kbId), ...extraKbs, ...activeJobs.map((j) => j.kbId)]),
  ];
```

替换为（新增：默认选中第一个集合 + 当前集合文档 + 前端搜索过滤）：

```tsx
  const activeJobs = jobs.filter((j) => ACTIVE.includes(j.status));
  // 集合全集 = 后端集合 ∪ 本地新建 ∪ 有处理中任务的集合（新集合首传时其 job 的 kbId 可能尚未进 kbs）。
  const collIds = [
    ...new Set<string>([...kbs.map((k) => k.kbId), ...extraKbs, ...activeJobs.map((j) => j.kbId)]),
  ];
  // 无选中集合时默认选第一个（去掉「全部文档」入口，集合为唯一组织维度）。
  const currentKb = selectedKb ?? collIds[0];
  // 当前集合文档 + 处理中任务。
  const collDocs = currentKb ? allDocs.filter((d) => d.kbId === currentKb) : [];
  const jobsHere = currentKb ? activeJobs.filter((j) => j.kbId === currentKb) : [];
  // 前端搜索：仅按文件名（大小写不敏感），输入即过滤。
  const needle = q.trim().toLowerCase();
  const filteredDocs = needle ? collDocs.filter((d) => d.source.toLowerCase().includes(needle)) : collDocs;
```

- [ ] **Step 3: 替换上传目标引用 `open` → `currentKb`**

上传按钮 title 与 `onFiles` 目标集合从 `open` 改为 `currentKb`。找到 `onFiles` 函数中的：

```tsx
    const target = open || "default";
```

替换为：

```tsx
    const target = currentKb || "default";
```

然后找到上传按钮的 title（约 234 行）：

```tsx
            title={`上传到集合「${open || "default"}」`}
```

替换为：

```tsx
            title={`上传到集合「${currentKb || "default"}」`}
```

- [ ] **Step 4: `confirmColl` 中 `setOpen` → `setSelectedKb`**

新建集合后应选中它。找到 `confirmColl` 中的：

```tsx
    setOpen(id); // 展开并成为上传目标
```

替换为：

```tsx
    setSelectedKb(id); // 选中并成为上传目标
    setQ(""); // 切集合清空搜索
```

- [ ] **Step 5: 重写主体 JSX —— 删除手风琴，改为左集合栏 + 右文档卡片网格**

找到主体部分（从 `<div className="kb-ov-body kb-acc-body">` 开始，到对应的 `</div>` 结束，即手风琴 + 预览整块）。整块替换为下面的双栏结构。

要替换的旧代码起点（约 256 行）：
```tsx
        <div className="kb-ov-body kb-acc-body">
          <div className="kb-acc">
```
...一直到（约 407 行，预览面板结束）：
```tsx
          </div>
        </div>
```

替换为：

```tsx
        <div className="kb-ov-body">
          {/* 左：集合导航 */}
          <div className="kb-colls">
            <div className="kb-colls-h">集合</div>
            {creating && (
              <div className="kb-coll-new">
                <input
                  className="kb-coll-new-input"
                  autoFocus
                  placeholder="集合名（英文 / 数字 / 连字符）"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") confirmColl();
                    else if (e.key === "Escape") cancelColl();
                  }}
                />
                <button className="kb-pv-btn" title="创建" onClick={confirmColl}>
                  <CheckIcon size={15} />
                </button>
                <button className="kb-pv-btn" title="取消" onClick={cancelColl}>
                  <XIcon size={15} />
                </button>
              </div>
            )}
            {collIds.length === 0 && !creating && (
              <div className="kb-colls-empty">还没有集合</div>
            )}
            {collIds.map((id) => {
              const docs = allDocs.filter((d) => d.kbId === id);
              const ft = dominantType(docs.map((d) => d.source));
              const Icon = ft?.Icon ?? KbIcon;
              const isSel = currentKb === id;
              const procHere = activeJobs.some((j) => j.kbId === id);
              return (
                <button
                  key={id}
                  className={`kb-coll ${isSel ? "on" : ""}`}
                  onClick={() => {
                    setSelectedKb(id);
                    setQ("");
                  }}
                >
                  <span className="kb-coll-ico" style={{ background: ft?.color ?? "var(--accent)" }}>
                    <Icon size={14} />
                  </span>
                  <span className="kb-coll-name">{id}</span>
                  {procHere && <span className="kb-coll-proc" title="处理中" />}
                  <span className="kb-coll-n">{docs.length}</span>
                </button>
              );
            })}
          </div>

          {/* 右：文档区（标题 + 搜索 + 卡片网格） */}
          <div className="kb-docs">
            <div className="kb-docs-h">
              <span className="kb-docs-h-name">{currentKb ?? "—"}</span>
              <span className="kb-docs-h-n">· {filteredDocs.length} 文档</span>
              <div className="kb-search">
                <input
                  placeholder="搜索文件名…"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                />
              </div>
            </div>

            <div className="kb-doc-grid">
              {/* 处理中卡片 */}
              {jobsHere.map((j) => (
                <div key={j.id} className="kb-doc-card proc">
                  <div className="kb-doc-card-top">
                    <span className="kb-ov-badge" style={{ background: fileBadge(j.source).color }}>
                      {fileBadge(j.source).label}
                    </span>
                    <span className="kb-doc-card-name">{j.source}</span>
                  </div>
                  <div className="kb-proc-bar">
                    <div
                      className="kb-proc-fill"
                      style={
                        j.status === "embedding" && j.total
                          ? { width: `${Math.round(((j.done ?? 0) / j.total) * 100)}%` }
                          : { width: "100%", animation: "proc-indet 1.2s ease-in-out infinite" }
                      }
                    />
                  </div>
                  <div className="kb-doc-card-meta">
                    <span className="spin" style={{ display: "inline-block" }}>◌</span>{" "}
                    {STATUS_LABEL[j.status] ?? j.status}
                    {j.status === "embedding" && j.total ? ` ${j.done ?? 0}/${j.total}` : ""}
                  </div>
                </div>
              ))}

              {/* 文档卡片 */}
              {filteredDocs.map((d) => {
                const b = fileBadge(d.source);
                return (
                  <button
                    key={d.id}
                    className={`kb-doc-card ${sel === d.id ? "on" : ""}`}
                    onClick={() => void openDoc(d.id)}
                  >
                    <div className="kb-doc-card-top">
                      <span className="kb-ov-badge" style={{ background: b.color }}>
                        {b.label}
                      </span>
                      <span className="kb-doc-card-name">{d.source}</span>
                      <span
                        className="kb-doc-card-del"
                        title="删除"
                        onClick={(e) => void del(d.id, e)}
                      >
                        <TrashIcon size={14} />
                      </span>
                    </div>
                    <div className="kb-doc-card-meta">
                      {d.chunks} 片段 · {relTime(d.createdAt)}
                    </div>
                  </button>
                );
              })}

              {/* 空态 */}
              {collDocs.length === 0 && jobsHere.length === 0 && !creating && (
                <div className="kb-ov-empty grid-empty">
                  <BookIcon size={26} />
                  <p>空集合</p>
                  <span>点右上「上传」导入文档到此集合。</span>
                </div>
              )}
              {collDocs.length > 0 && filteredDocs.length === 0 && (
                <div className="kb-ov-empty grid-empty">
                  <BookIcon size={22} />
                  <p>没有匹配「{q}」的文档</p>
                </div>
              )}
            </div>
          </div>

          {/* 文档预览（右侧滑出，复用工作台视觉） */}
          <div className={`kb-pv ${sel ? "open" : ""} ${maxed ? "max" : ""}`}>
            {sel && (
              <>
                <div className="kb-pv-top">
                  <button className="kb-pv-btn" title="返回" onClick={closePreview}>
                    <ArrowLeftIcon size={15} />
                  </button>
                  <span className="kb-pv-title">{content?.source ?? "…"}</span>
                  <span className="ad-spacer" />
                  <button className="kb-pv-btn" title={maxed ? "还原" : "放大"} onClick={() => setMaxed((m) => !m)}>
                    <MaximizeIcon size={14} />
                  </button>
                  <button className="kb-pv-btn" title="关闭" onClick={closePreview}>
                    <XIcon size={15} />
                  </button>
                </div>
                {!content ? (
                  <div className="kb-ov-empty pad">
                    <LoaderIcon size={20} className="spin" />
                  </div>
                ) : (
                  <>
                    <div className="kb-pv-meta">
                      <span className="kb-ov-badge sm" style={{ background: fileBadge(content.source).color }}>
                        {fileBadge(content.source).label}
                      </span>
                      <span>
                        {content.chunks} 片段 · {relTime(content.createdAt)} · {content.kbId}
                      </span>
                    </div>
                    {isMarkdown(content.source) ? (
                      <div className="kb-pv-body md">
                        <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                          {content.text || "（空文档）"}
                        </Markdown>
                      </div>
                    ) : (
                      <pre className="kb-pv-body pre">{content.text || "（空文档）"}</pre>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        </div>
```

- [ ] **Step 6: 清理不再使用的 import**

新 JSX 不再用 `ChevronIcon`、`ChevronDownIcon`（手风琴折叠箭头已删）、`PlusIcon`（集合栏的「新建」入口移到头部按钮，集合栏内的新建输入框不再带 `PlusIcon` 前缀）。

检查 import 列表，确认这些是否还被引用：
- `ChevronIcon` / `ChevronDownIcon` —— 手风琴专用，新结构不用了。若全文件无其他引用则删除。
- `PlusIcon` —— 头部「新建」按钮还用（`<PlusIcon size={15} /> 新建`），**保留**。
- `CheckIcon` —— 集合新建输入框确认按钮用，**保留**。

在 import 中删除 `ChevronIcon` 和 `ChevronDownIcon`：

```tsx
import {
  BookIcon,
  UploadIcon,
  TrashIcon,
  XIcon,
  LoaderIcon,
  PlusIcon,
  KbIcon,
  MaximizeIcon,
  ArrowLeftIcon,
  CheckIcon,
} from "../icons.js";
```

- [ ] **Step 7: 运行 typecheck 验证**

Run: `npm run typecheck --workspace @ew/ui`
Expected: PASS（无类型错误；若有未使用变量报错，按提示清理）

> 注意：此时样式尚未更新（Task 2 做），视觉会是错乱的，但逻辑与类型必须正确。typecheck 通过即可进入 Task 2。

- [ ] **Step 8: Commit**

```bash
git add apps/ui/src/components/KnowledgeBaseOverlay.tsx
git commit -m "refactor(ui): 知识库手风琴重构为左集合栏 + 右文档卡片网格

open→selectedKb + 前端文件名搜索(q)；卡片网格平铺文档；
去掉「全部文档」入口，默认选第一个集合。CSS 待下一步。"
```

---

## Task 2: 替换 CSS —— 删手风琴样式，新增集合栏/网格/搜索样式

**Files:**
- Modify: `apps/ui/src/styles.css`

- [ ] **Step 1: 删除手风琴 `.kb-acc-*` 样式块**

在 `styles.css` 中，删除从 `/* —— 集合手风琴（展开式） —— */` 注释开始到 `.kb-acc-new-input` 结束的整块（约 585-604 行）。即删除这些规则：

```css
/* —— 集合手风琴（展开式） —— */
.kb-acc-body { position: relative; overflow: hidden; }
.kb-acc { flex: 1; min-width: 0; overflow-y: auto; padding: 14px 16px 20px; display: flex; flex-direction: column; gap: 6px; }
.kb-acc-group { border: 1px solid var(--border); border-radius: 11px; background: var(--color-bg-card); overflow: hidden; }
.kb-acc-group.open { border-color: var(--border-strong); }
.kb-acc-row { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; padding: 11px 13px; background: transparent; border: none; cursor: pointer; color: var(--text); }
.kb-acc-row:hover { background: var(--color-bg-tertiary); }
.kb-acc-caret { flex: none; display: grid; place-items: center; color: var(--text-tertiary); }
.kb-acc-icon { flex: none; width: 30px; height: 30px; border-radius: 8px; display: grid; place-items: center; color: #fff; }
.kb-acc-name { flex: 1; font-size: 13.5px; font-weight: 600; font-family: var(--font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kb-acc-proc { flex: none; display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 600; color: var(--accent); background: var(--accent-soft); padding: 2px 8px; border-radius: 20px; }
.kb-acc-count { flex: none; font-family: var(--font-mono); font-size: 11.5px; color: var(--text-tertiary); }
.kb-acc-docs { padding: 4px 12px 12px 12px; display: flex; flex-direction: column; gap: 4px; border-top: 1px solid var(--border-soft); }
.kb-acc-docs .kb-ov-doc { border: none; border-radius: 8px; background: transparent; padding: 8px 10px; gap: 10px; }
.kb-acc-docs .kb-ov-doc:hover { background: var(--color-bg-tertiary); }
.kb-acc-docs .kb-ov-doc.on { background: var(--accent-soft); }
.kb-acc-docs .kb-ov-badge { width: 30px; height: 30px; border-radius: 8px; }
.kb-acc-empty { font-size: 12px; color: var(--text-tertiary); padding: 10px 4px; text-align: center; }
.kb-acc-new { display: flex; align-items: center; gap: 8px; padding: 9px 12px; border: 1px solid var(--accent); border-radius: 11px; background: var(--color-bg-card); color: var(--text-tertiary); }
.kb-acc-new-input { flex: 1; min-width: 0; border: none; background: transparent; color: var(--text); font-size: 13.5px; font-family: var(--font-mono); padding: 2px 0; outline: none; }
```

**保留** `.kb-ov-doc`、`.kb-ov-badge`、`.kb-ov-doc-body` 等（滑出预览 meta 区的 `.kb-ov-badge.sm` 仍用 `.kb-ov-badge` 基类）。

- [ ] **Step 2: 新增集合栏 `.kb-coll-*` + 文档区 `.kb-docs-*` + 网格 `.kb-doc-grid` + 卡片 `.kb-doc-card` + 搜索 `.kb-search` 样式**

在刚删除的位置（`.kb-ov-newcoll:hover` 之后、`.kb-ov-doc` 之前），插入新样式：

```css
/* —— 知识库：左集合栏 + 右文档卡片网格 —— */
.kb-ov-body { position: relative; overflow: hidden; }
/* 左：集合栏 */
.kb-colls { width: 210px; flex: none; padding: 12px 10px; border-right: 1px solid var(--border); display: flex; flex-direction: column; gap: 2px; overflow-y: auto; }
.kb-colls-h { font-size: 10.5px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-tertiary); font-family: var(--font-mono); padding: 4px 6px 8px; }
.kb-colls-empty { font-size: 12px; color: var(--text-tertiary); padding: 12px 6px; text-align: center; }
.kb-coll { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; padding: 8px 10px; border: none; border-radius: 8px; background: transparent; color: var(--text-2); font-size: 13px; font-weight: 550; cursor: pointer; }
.kb-coll:hover { background: var(--color-bg-tertiary); color: var(--text); }
.kb-coll.on { background: var(--accent-soft); color: var(--accent); }
.kb-coll-ico { flex: none; width: 22px; height: 22px; border-radius: 6px; display: grid; place-items: center; color: #fff; }
.kb-coll-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kb-coll-proc { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--accent); animation: kb-pulse 1.2s ease-in-out infinite; }
.kb-coll-n { flex: none; font-family: var(--font-mono); font-size: 11px; color: var(--text-tertiary); }
.kb-coll.on .kb-coll-n { color: var(--accent); }
@keyframes kb-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
.kb-coll-new { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border: 1px solid var(--accent); border-radius: 8px; background: var(--color-bg-card); margin-bottom: 4px; }
.kb-coll-new-input { flex: 1; min-width: 0; border: none; background: transparent; color: var(--text); font-size: 13px; font-family: var(--font-mono); padding: 2px 0; outline: none; }
/* 右：文档区 */
.kb-docs { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
.kb-docs-h { display: flex; align-items: center; gap: 6px; padding: 12px 16px; border-bottom: 1px solid var(--border-soft); }
.kb-docs-h-name { font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-tertiary); font-family: var(--font-mono); }
.kb-docs-h-n { font-weight: 500; color: var(--text-2); font-size: 11px; }
.kb-search { margin-left: auto; display: flex; align-items: center; height: 28px; }
.kb-search input { width: 150px; height: 28px; padding: 0 10px; border: 1px solid var(--border); border-radius: 7px; background: var(--color-bg-card); color: var(--text); font-size: 12px; outline: none; }
.kb-search input:focus { border-color: var(--accent); }
.kb-search input::placeholder { color: var(--text-tertiary); }
/* 文档卡片网格 */
.kb-doc-grid { flex: 1; overflow-y: auto; padding: 14px 16px; display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; align-content: start; }
.kb-doc-card { display: flex; flex-direction: column; gap: 8px; padding: 13px; border: 1px solid var(--border); border-radius: 12px; background: var(--color-bg-card); cursor: pointer; transition: border-color 0.12s, transform 0.12s; text-align: left; }
.kb-doc-card:hover { border-color: var(--border-strong); transform: translateY(-1px); }
.kb-doc-card.on { border-color: var(--color-accent-border); background: var(--accent-soft); }
.kb-doc-card.proc { border-style: dashed; border-color: var(--color-accent-border); cursor: default; }
.kb-doc-card.proc:hover { transform: none; }
.kb-doc-card-top { display: flex; align-items: center; gap: 8px; }
.kb-doc-card .kb-ov-badge { width: 30px; height: 30px; border-radius: 8px; }
.kb-doc-card-name { flex: 1; min-width: 0; font-size: 13px; font-weight: 600; font-family: var(--font-mono); color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kb-doc-card-del { flex: none; display: grid; place-items: center; width: 22px; height: 22px; border-radius: 5px; color: var(--text-tertiary); opacity: 0; }
.kb-doc-card:hover .kb-doc-card-del { opacity: 1; }
.kb-doc-card-del:hover { background: var(--color-danger-soft); color: var(--err); }
.kb-doc-card-meta { font-size: 11px; color: var(--text-tertiary); font-family: var(--font-mono); display: flex; align-items: center; gap: 5px; }
.kb-proc-bar { height: 3px; background: var(--border); border-radius: 2px; overflow: hidden; }
.kb-proc-fill { height: 100%; background: var(--accent); border-radius: 2px; }
@keyframes proc-indet { 0% { transform: translateX(-100%); } 100% { transform: translateX(100%); } }
.kb-ov-empty.grid-empty { grid-column: 1 / -1; }
```

- [ ] **Step 3: 运行 lint 验证**

Run: `npm run lint`
Expected: PASS（0 error）。若有 `no-unused` 类警告说明 Task 1 有遗留，回头清理。

- [ ] **Step 4: 运行 UI build 验证**

Run: `npm run build --workspace @ew/ui`
Expected: PASS（Vite 构建成功，无 CSS/TS 错误）

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/styles.css
git commit -m "style(ui): 知识库新布局样式（集合栏 + 卡片网格 + 搜索框）

删 .kb-acc-* 手风琴；新增 .kb-coll-* / .kb-doc-grid / .kb-doc-card / .kb-search；
处理中卡片虚线边 + 进度条；集合脉冲点。"
```

---

## Task 3: 全量验证 + 手动冒烟

**Files:** 无（验证任务）

- [ ] **Step 1: 全量 typecheck**

Run: `npm run typecheck`
Expected: 19/19 通过（与 CLAUDE.md 基线一致）

- [ ] **Step 2: 全量测试（确认后端零回归）**

Run: `npm test`
Expected: 201 测试全绿（本改动纯前端，不应影响后端测试）

- [ ] **Step 3: 手动冒烟（dev:ui + dev:daemon）**

启动 daemon 与 UI：

```bash
# 终端 1
npm run dev:daemon
# 复制 stdout 首行的 {baseUrl, token}

# 终端 2
npm run dev:ui
# 浏览器打开 http://localhost:5173/?baseUrl=<daemon>&token=<token>
```

在浏览器验证（无本地模型也可，知识库是独立功能）：
1. 进「插件」→「知识库」标签。
2. 左侧集合栏显示，点击切换右侧文档。
3. 右侧文档以卡片网格平铺（角标 + 文件名 + 片段数·时间）。
4. 搜索框输入文件名片段，卡片即时过滤；清空恢复。
5. 点卡片 → 右侧滑出预览（md 渲染 / 纯文本 / 放大按钮）。
6. 「新建集合」→ 行内输入 → Enter 创建并选中。
7. 「上传」选文件 → 处理中卡片出现虚线边 + 进度；完成后变正常卡片。
8. hover 卡片 → 删除按钮 → 点击删除。
9. 无集合时显示空态。

- [ ] **Step 4: 确认无回归后无需额外 commit**

（本任务仅验证，无代码改动。如冒烟发现问题，回到对应 Task 修复。）

---

## Self-Review Checklist（已执行）

**1. Spec 覆盖：**
- ✅ 左集合栏常驻（Task 1 Step 5 `kb-colls`）
- ✅ 响应式卡片网格（Task 2 Step 2 `.kb-doc-grid` auto-fill 200px）
- ✅ 卡片 = 角标 + 名称 + 片段数·时间，无摘要（Task 1 Step 5）
- ✅ 前端文件名搜索（Task 1 Step 2 `filteredDocs` + Task 2 `.kb-search`）
- ✅ 去掉「全部文档」入口，默认选第一个集合（Task 1 Step 2 `currentKb = selectedKb ?? collIds[0]`）
- ✅ 切集合清空搜索（Task 1 Step 4 `confirmColl` + Step 5 集合 `onClick`）
- ✅ 处理中集合脉冲点（Task 2 `.kb-coll-proc` + `kb-pulse`）
- ✅ 处理中卡片虚线边 + 进度条（Task 1 Step 5 + Task 2 `.kb-doc-card.proc`）
- ✅ 滑出预览复用（Task 1 Step 5 `kb-pv` 块原样保留）
- ✅ 上传/新建/删除/轮询不回归（逻辑函数未删，仅 state 改名）
- ✅ 后端零改动（无 store/sdk/app.ts 任务）

**2. Placeholder scan：** 无 TBD/TODO；每步含完整代码。

**3. Type consistency：** `selectedKb`/`currentKb`/`q`/`setQ`/`filteredDocs`/`collDocs`/`jobsHere` 在各步命名一致；`setOpen`→`setSelectedKb` 全部替换。
