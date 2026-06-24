# 交互式设计文档

`index.html` 是 [`docs/DESIGN.md`](../DESIGN.md) 的**交互式网页版**：左侧目录（滚动高亮）、章节搜索、明暗切换、代码一键复制。

## 用法

- **直接打开**：双击 `index.html`（或拖进浏览器）即可。Markdown 已内联进页面，离线也能看；联网时用 [marked](https://github.com/markedjs/marked)（CDN）获得完整排版。
- **本地服务器**（可选）：`python3 -m http.server` 后访问 `http://localhost:8000/docs/design-web/`。

## 维护

页面**不复制内容**——构建时把 `DESIGN.md` 原文内联进 `index.html` 的 `<script type="text/markdown">`。改文档后重新生成：

```bash
cat docs/design-web/_head.html docs/DESIGN.md docs/design-web/_tail.html > docs/design-web/index.html
```

（`_head.html` = 页面外壳 + 样式 + 目录/搜索/主题骨架；`_tail.html` = 渲染与交互脚本。源文档真相源始终是 `docs/DESIGN.md`。）
