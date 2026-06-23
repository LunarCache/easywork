import { useState } from "react";
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
  return (
    <div className="plugins-view">
      <div className="plugins-tabs">
        {TABS.map((t) => (
          <button key={t.id} className={`plugins-tab ${tab === t.id ? "on" : ""}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="plugins-body">
        {tab === "models" && <Models onChange={onModelsChange} />}
        {tab === "kb" && <KnowledgeBaseOverlay embedded />}
        {tab === "skills" && <Skills />}
        {tab === "mcp" && <Mcp />}
        {tab === "memory" && <MemoryOverlay embedded />}
      </div>
    </div>
  );
}
