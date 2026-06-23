import { useState, type ReactNode } from "react";
import { Models } from "./Models.js";
import { Skills } from "./Skills.js";
import { Mcp } from "./Mcp.js";
import { KnowledgeBaseOverlay } from "../components/KnowledgeBaseOverlay.js";
import { MemoryOverlay } from "../components/MemoryOverlay.js";

type PTab = "models" | "kb" | "skills" | "mcp" | "memory";

const TABS: { id: PTab; label: string }[] = [
  { id: "models", label: "模型" },
  { id: "kb", label: "知识库" },
  { id: "skills", label: "Skills" },
  { id: "mcp", label: "MCP" },
  { id: "memory", label: "记忆" },
];

/**
 * 「插件」主视图（参考设计）：顶部标签切换 模型 / 知识库 / Skills / MCP / 记忆，
 * 各标签直接在主区内嵌渲染对应管理页（不再用浮层）。
 */
export function PluginsView({ initial, onModelsChange }: { initial?: PTab; onModelsChange: () => void }) {
  const [tab, setTab] = useState<PTab>(initial ?? "models");
  // 已访问过的标签保持挂载（CSS 隐藏非当前页），避免切走再回来丢失内部状态——
  // 尤其是知识库的上传/索引进度轮询会因卸载而中断、进度卡消失。
  const [visited, setVisited] = useState<Set<PTab>>(() => new Set<PTab>([initial ?? "models"]));
  const open = (id: PTab) => {
    setVisited((v) => (v.has(id) ? v : new Set(v).add(id)));
    setTab(id);
  };
  const pane = (id: PTab, node: ReactNode) =>
    visited.has(id) ? (
      <div key={id} className={`plugins-pane ${tab === id ? "" : "hidden"}`}>
        {node}
      </div>
    ) : null;
  return (
    <div className="plugins-view">
      <div className="plugins-tabs">
        {TABS.map((t) => (
          <button key={t.id} className={`plugins-tab ${tab === t.id ? "on" : ""}`} onClick={() => open(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="plugins-body">
        {pane("models", <Models onChange={onModelsChange} />)}
        {pane("kb", <KnowledgeBaseOverlay embedded />)}
        {pane("skills", <Skills />)}
        {pane("mcp", <Mcp />)}
        {pane("memory", <MemoryOverlay embedded />)}
      </div>
    </div>
  );
}
