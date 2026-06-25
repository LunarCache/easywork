// 斜杠命令自动补全面板 + 键盘交互 hook（Chat / Workspace composer 共用）。
// 两阶段：① 命令名（/think /model /compact，按前缀过滤）→ 选无参命令即执行，选带参命令补「/x 」进参数阶段；
//         ② 参数（think 4 档 / model 模糊匹配）→ 选中即执行并清空输入。
import { useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import type { ThinkLevel } from "@ew/shared";
import { matchCmds, parseCmd, slashQuery, THINK_LEVELS } from "../lib/slash.js";

export interface SlashHandlers {
  models: string[];
  onThink: (level: ThinkLevel) => void;
  onModel: (model: string) => void;
  onCompact: () => void;
}

interface Item {
  label: string;
  hint?: string;
  run: () => void;
}

export function useSlashPalette(
  input: string,
  setInput: (v: string) => void,
  h: SlashHandlers,
): { palette: ReactNode; onKeyDown: (e: KeyboardEvent) => boolean } {
  const [idx, setIdx] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  const q = slashQuery(input);
  const items = useMemo<Item[]>(() => {
    if (q == null) return [];
    const hasSpace = q.includes(" ");
    if (!hasSpace) {
      // 命令名阶段
      return matchCmds(q).map((c) => ({
        label: `/${c.name}`,
        hint: c.arg ? `${c.desc} · ${c.arg}` : c.desc,
        run: () => {
          if (c.name === "compact") {
            h.onCompact();
            setInput("");
          } else {
            setInput(`/${c.name} `); // 进入参数阶段
          }
        },
      }));
    }
    // 参数阶段
    const { name, arg } = parseCmd(input);
    if (name === "think") {
      return THINK_LEVELS.filter((l) => l.startsWith(arg.toLowerCase())).map((lv) => ({
        label: lv,
        run: () => {
          h.onThink(lv);
          setInput("");
        },
      }));
    }
    if (name === "model") {
      const a = arg.toLowerCase();
      return h.models
        .filter((m) => m.toLowerCase().includes(a))
        .slice(0, 8)
        .map((m) => ({
          label: m,
          run: () => {
            h.onModel(m);
            setInput("");
          },
        }));
    }
    return [];
  }, [q, input, h, setInput]);

  const active = q != null && !dismissed && items.length > 0;
  const sel = items.length ? Math.min(idx, items.length - 1) : 0;

  const onKeyDown = (e: KeyboardEvent): boolean => {
    if (q == null && dismissed) setDismissed(false); // 离开命令态后复位
    if (!active) return false;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIdx((i) => (Math.min(i, items.length - 1) + 1) % items.length);
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setIdx((i) => (Math.min(i, items.length - 1) - 1 + items.length) % items.length);
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      items[sel]?.run();
      setIdx(0);
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setDismissed(true);
      return true;
    }
    return false;
  };

  const palette: ReactNode = active ? (
    <div className="slash-pal" role="listbox">
      {items.map((it, i) => (
        <button
          key={it.label}
          type="button"
          className={`slash-item ${i === sel ? "on" : ""}`}
          role="option"
          aria-selected={i === sel}
          onMouseEnter={() => setIdx(i)}
          onMouseDown={(e) => {
            e.preventDefault(); // 不抢 textarea 焦点
            it.run();
            setIdx(0);
          }}
        >
          <span className="slash-label">{it.label}</span>
          {it.hint && <span className="slash-hint">{it.hint}</span>}
        </button>
      ))}
    </div>
  ) : null;

  return { palette, onKeyDown };
}
