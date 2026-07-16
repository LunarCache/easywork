import { useEffect, useMemo, useState } from "react";
import type { ThinkLevel } from "@ew/shared";
import type { ModelSourceInfo } from "@ew/sdk";
import { modelLabel } from "../lib/agent-stream.js";
import { THINK_LABEL, THINK_LEVELS, THINK_META } from "../lib/slash.js";
import { ArrowLeftIcon, CheckIcon, ChevronDownIcon, ChevronIcon } from "../icons.js";

interface ModelGroup {
  key: string;
  label: string;
  models: string[];
}

type MenuView = "main" | "models" | "thinking";

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

export function ModelThinkingSelect({
  models,
  sources = [],
  model,
  thinkingLevel,
  onModelChange,
  onThinkingLevelChange,
  testId,
}: {
  models: string[];
  sources?: ModelSourceInfo[];
  model: string;
  thinkingLevel: ThinkLevel;
  onModelChange: (model: string) => void;
  onThinkingLevelChange: (level: ThinkLevel) => void;
  testId: string;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<MenuView>("main");
  const empty = models.length === 0;
  const sourceByModel = useMemo(() => new Map(sources.map((source) => [source.id, source])), [sources]);
  const groups = useMemo<ModelGroup[]>(() => {
    const byKey = new Map<string, ModelGroup>();
    for (const modelId of models) {
      const source = sourceByModel.get(modelId);
      const key = keyForSource(source);
      const group = byKey.get(key) ?? { key, label: labelForSource(source), models: [] };
      group.models.push(modelId);
      byKey.set(key, group);
    }
    return [...byKey.values()];
  }, [models, sourceByModel]);
  const currentLabel = displayModelLabel(model, sourceByModel.get(model)) || "选择模型";
  const showGroupHeaders = groups.length > 1 || groups.some((group) => group.key !== "models");

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  const close = () => {
    setOpen(false);
    setView("main");
  };

  const openView = (nextView: MenuView) => setView(nextView);

  return (
    <div className="model-thinking">
      <button
        type="button"
        className="model-sel-btn strip"
        data-testid={`${testId}-trigger`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${empty ? "选择模型" : currentLabel} · 推理强度 ${THINK_LABEL[thinkingLevel]}`}
        onClick={() => {
          setView("main");
          setOpen((value) => !value);
        }}
      >
        <span className="model-sel-label">
          <span className="model-sel-name">{empty ? "选择模型" : currentLabel}</span>
        </span>
        <span className="model-thinking-trigger-level">{THINK_LABEL[thinkingLevel]}</span>
        <ChevronDownIcon size={14} className="model-sel-chev" />
      </button>

      {open && (
        <>
          <div className="menu-backdrop" onClick={close} />
          <div className="model-thinking-menu" role="menu" data-testid={`${testId}-menu`}>
            {view === "main" ? (
              <>
                <button
                  type="button"
                  className="model-thinking-row"
                  data-testid={`${testId}-model-row`}
                  onClick={() => openView("models")}
                >
                  <span className="model-thinking-row-label">模型</span>
                  <span className="model-thinking-row-value">{currentLabel}</span>
                  <ChevronIcon size={17} />
                </button>
                <button
                  type="button"
                  className="model-thinking-row"
                  data-testid={`${testId}-level-row`}
                  onClick={() => openView("thinking")}
                >
                  <span className="model-thinking-row-label">推理强度</span>
                  <span className="model-thinking-row-value">{THINK_LABEL[thinkingLevel]}</span>
                  <ChevronIcon size={17} />
                </button>
              </>
            ) : (
              <>
                <div className="model-thinking-menu-head">
                  <button type="button" onClick={() => openView("main")} aria-label="返回">
                    <ArrowLeftIcon size={16} />
                  </button>
                  <span>{view === "models" ? "模型" : "推理强度"}</span>
                </div>
                <div className="model-thinking-options">
                  {view === "models" ? (
                    empty ? (
                      <div className="model-thinking-empty">暂无可用模型，请先前往“模型”页面配置。</div>
                    ) : (
                      groups.map((group) => (
                        <div className="model-thinking-group" key={group.key}>
                          {showGroupHeaders && <div className="model-thinking-group-label">{group.label}</div>}
                          {group.models.map((modelId) => (
                            <button
                              type="button"
                              className={`model-thinking-option ${modelId === model ? "on" : ""}`}
                              data-testid={`${testId}-model-${modelId}`}
                              key={modelId}
                              onClick={() => {
                                onModelChange(modelId);
                                close();
                              }}
                            >
                              <span>{displayModelLabel(modelId, sourceByModel.get(modelId))}</span>
                              {modelId === model && <CheckIcon size={15} />}
                            </button>
                          ))}
                        </div>
                      ))
                    )
                  ) : (
                    THINK_LEVELS.map((level) => (
                      <button
                        type="button"
                        className={`model-thinking-option level ${level === thinkingLevel ? "on" : ""}`}
                        data-testid={`${testId}-level-${level}`}
                        key={level}
                        onClick={() => {
                          onThinkingLevelChange(level);
                          close();
                        }}
                      >
                        <span className="model-thinking-option-copy">
                          <span>{THINK_META[level].label}</span>
                          <span>{THINK_META[level].hint}</span>
                        </span>
                        {level === thinkingLevel && <CheckIcon size={15} />}
                      </button>
                    ))
                  )}
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
