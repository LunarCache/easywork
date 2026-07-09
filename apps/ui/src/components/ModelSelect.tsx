import { useMemo, useState } from "react";
import type { ModelSourceInfo } from "@ew/sdk";
import { modelLabel } from "../lib/agent-stream.js";
import { ChevronDownIcon, ChevronIcon, CheckIcon } from "../icons.js";

interface ModelGroup {
  key: string;
  label: string;
  models: string[];
}

function labelForSource(source: ModelSourceInfo | undefined): string {
  if (!source) return "模型";
  if (source.kind === "local") return "本地模型";
  if (source.kind === "provider") return source.label || source.providerId || "云端 Provider";
  return source.label || "其它模型";
}

function keyForSource(source: ModelSourceInfo | undefined): string {
  if (!source) return "models";
  if (source.kind === "provider") return `provider:${source.providerId ?? source.label}`;
  return source.kind;
}

function displayModelLabel(model: string, source: ModelSourceInfo | undefined): string {
  return modelLabel(source?.modelId ?? model);
}

/** 模型下拉：自定义弹出菜单（取代原生 <select>，与 Agent Desk 风格一致）。 */
export function ModelSelect({
  models,
  sources = [],
  value,
  onChange,
  up,
  align = "left",
  variant = "default",
}: {
  models: string[];
  sources?: ModelSourceInfo[];
  value: string;
  onChange: (m: string) => void;
  /** 弹出菜单向上展开（用于贴底的 composer）。 */
  up?: boolean;
  align?: "left" | "right";
  variant?: "default" | "strip";
}) {
  const [open, setOpen] = useState(false);
  const [activeSourceKey, setActiveSourceKey] = useState<string | null>(null);
  const empty = models.length === 0;
  const sourceByModel = useMemo(() => new Map(sources.map((source) => [source.id, source])), [sources]);
  const groups = useMemo<ModelGroup[]>(() => {
    const byKey = new Map<string, ModelGroup>();
    for (const model of models) {
      const source = sourceByModel.get(model);
      const key = keyForSource(source);
      const group = byKey.get(key) ?? { key, label: labelForSource(source), models: [] };
      group.models.push(model);
      byKey.set(key, group);
    }
    return [...byKey.values()];
  }, [models, sourceByModel]);
  const currentSource = sourceByModel.get(value);
  const currentGroupKey = groups.find((group) => group.models.includes(value))?.key;
  const activeKey = groups.some((group) => group.key === activeSourceKey) ? activeSourceKey : null;
  const activeGroupKey = activeKey ?? currentGroupKey ?? groups[0]?.key;
  const activeGroup = groups.find((group) => group.key === activeGroupKey) ?? groups[0];
  const showGroupHeaders = groups.length > 1 || groups.some((group) => group.key !== "models");
  const modelList = activeGroup?.models ?? models;
  return (
    <div className="model-sel">
      <button
        className={`model-sel-btn ${variant === "strip" ? "strip" : ""}`}
        disabled={empty}
        onClick={() => {
          setActiveSourceKey(currentGroupKey ?? groups[0]?.key ?? null);
          setOpen((v) => !v);
        }}
        title={empty ? undefined : displayModelLabel(value, currentSource)}
      >
        <span className="model-sel-label">
          {empty ? (
            "（无可用模型，请先在「模型」页加载或配置）"
          ) : (
            <span className="model-sel-name">{displayModelLabel(value, currentSource) || "选择模型"}</span>
          )}
        </span>
        {!empty && <ChevronDownIcon size={14} className="model-sel-chev" />}
      </button>
      {open && !empty && (
        <>
          <div className="menu-backdrop" onClick={() => setOpen(false)} />
          <div className={`model-cascade ${up ? "up" : ""} ${align === "right" ? "right" : ""}`}>
            {showGroupHeaders && (
              <div className="model-pop model-pop-source">
                <div className="model-pop-title">Provider</div>
                {groups.map((group) => (
                  <button
                    key={group.key}
                    type="button"
                    className={`model-pop-source-item ${activeGroupKey === group.key ? "on" : ""}`}
                    onMouseEnter={() => setActiveSourceKey(group.key)}
                    onFocus={() => setActiveSourceKey(group.key)}
                    onClick={() => setActiveSourceKey(group.key)}
                  >
                    <span className="model-pop-source-name">{group.label}</span>
                    <span className="model-pop-source-meta">
                      <span>{group.models.length}</span>
                      <ChevronIcon size={13} />
                    </span>
                  </button>
                ))}
              </div>
            )}
            <div className={`model-pop model-pop-models ${showGroupHeaders ? "" : "single"}`}>
              <div className="model-pop-title">Model</div>
              <div className="model-pop-list">
                {modelList.map((m) => (
                  <button
                    key={m}
                    className={`model-pop-item ${m === value ? "on" : ""}`}
                    onClick={() => {
                      onChange(m);
                      setOpen(false);
                    }}
                  >
                    <span className="model-pop-name">{displayModelLabel(m, sourceByModel.get(m))}</span>
                    {m === value && <CheckIcon size={14} />}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
