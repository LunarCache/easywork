import { useState } from "react";
import { modelLabel } from "../lib/agent-stream.js";
import { ChevronDownIcon, CheckIcon } from "../icons.js";

/** 模型下拉：自定义弹出菜单（取代原生 <select>，与 Agent Desk 风格一致）。 */
export function ModelSelect({
  models,
  value,
  onChange,
}: {
  models: string[];
  value: string;
  onChange: (m: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const empty = models.length === 0;
  return (
    <div className="model-sel">
      <button
        className="model-sel-btn"
        disabled={empty}
        onClick={() => setOpen((v) => !v)}
        title={value || undefined}
      >
        <span className="model-sel-label">
          {empty ? "（无可用模型，请先在「模型」页加载或配置）" : modelLabel(value) || "选择模型"}
        </span>
        {!empty && <ChevronDownIcon size={14} className="model-sel-chev" />}
      </button>
      {open && !empty && (
        <>
          <div className="menu-backdrop" onClick={() => setOpen(false)} />
          <div className="model-pop">
            {models.map((m) => (
              <button
                key={m}
                className={`model-pop-item ${m === value ? "on" : ""}`}
                onClick={() => {
                  onChange(m);
                  setOpen(false);
                }}
              >
                <span className="model-pop-name">{modelLabel(m)}</span>
                {m === value && <CheckIcon size={14} />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
