// 斜杠命令自动补全面板 + 键盘交互 hook（Chat / Workspace composer 共用）。
// 两阶段：① 命令名（/think /model /compact，按前缀过滤）→ 选无参命令即执行，选带参命令补「/x 」进参数阶段；
//         ② 参数（think 4 档 / model 模糊匹配）→ 选中即执行并清空输入。
import { useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import type { ThinkLevel } from "@ew/shared";
import { modelLabel } from "../lib/agent-stream.js";
import { matchCmds, parseCmd, slashQuery, THINK_LEVELS, THINK_LABEL, THINK_META } from "../lib/slash.js";
import { BrainIcon, CheckIcon, ClockIcon, EnterIcon, ThinkIcon } from "../icons.js";

type SlashIcon = typeof BrainIcon;

export interface SlashHandlers {
  models: string[];
  currentModel: string;
  currentThink: ThinkLevel;
  usagePct?: number | null;
  onThink: (level: ThinkLevel) => void;
  onModel: (model: string) => void;
  onCompact: () => void;
}

interface Item {
  key: string;
  title: string;
  desc: string;
  cmd: string;
  value?: string;
  active?: boolean;
  tone?: "default" | "warn";
  Icon: SlashIcon;
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
  const stage = q == null ? null : q.includes(" ") ? parseCmd(input).name : "root";
  const items = useMemo<Item[]>(() => {
    if (q == null) return [];
    const hasSpace = q.includes(" ");
    if (!hasSpace) {
      const usagePct = h.usagePct == null ? null : Math.max(0, Math.min(100, h.usagePct));
      return matchCmds(q).map((c) => {
        if (c.name === "model") {
          return {
            key: c.name,
            title: "切换模型",
            desc: c.desc,
            cmd: "/model",
            value: modelLabel(h.currentModel),
            Icon: BrainIcon,
            run: () => setInput("/model "),
          } satisfies Item;
        }
        if (c.name === "think") {
          return {
            key: c.name,
            title: "思考强度",
            desc: c.desc,
            cmd: "/think",
            value: THINK_LABEL[h.currentThink],
            Icon: ThinkIcon,
            run: () => setInput("/think "),
          } satisfies Item;
        }
        return {
          key: c.name,
          title: "压缩上下文",
          desc: "整理会话历史，回收窗口空间",
          cmd: "/compact",
          value: usagePct == null ? undefined : `${Math.round(usagePct)}%`,
          tone: usagePct != null && usagePct > 65 ? "warn" : "default",
          Icon: ClockIcon,
          run: () => {
            h.onCompact();
            setInput("");
          },
        } satisfies Item;
      });
    }
    // 参数阶段
    const { name, arg } = parseCmd(input);
    if (name === "think") {
      return THINK_LEVELS.filter((l) => l.startsWith(arg.toLowerCase())).map((lv) => ({
        key: lv,
        title: THINK_LABEL[lv],
        desc: THINK_META[lv].hint,
        cmd: "/think",
        value: lv === h.currentThink ? "当前" : undefined,
        active: lv === h.currentThink,
        Icon: ThinkIcon,
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
          key: m,
          title: modelLabel(m),
          desc: m,
          cmd: "/model",
          value: m === h.currentModel ? "当前" : undefined,
          active: m === h.currentModel,
          Icon: BrainIcon,
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
      <div className="slash-head">
        <div className="slash-breadcrumb">
          <span className="slash-kbd">/</span>
          <span className="slash-stage">
            {stage === "root" ? "命令" : stage === "model" ? "正在设置 /model" : "正在设置 /think"}
          </span>
        </div>
        <div className="slash-help">
          <EnterIcon size={13} />
          <span>回车应用</span>
        </div>
      </div>
      {items.map((it, i) => (
        <button
          key={it.key}
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
          <span className={`slash-icon ${it.tone === "warn" ? "warn" : ""}`}>
            <it.Icon size={16} />
          </span>
          <span className="slash-main">
            <span className="slash-title">{it.title}</span>
            <span className="slash-sub">{it.desc}</span>
          </span>
          <span className="slash-meta">
            {it.value && <span className="set-pill">{it.value}</span>}
            {it.active ? <CheckIcon size={14} /> : <code>{it.cmd}</code>}
          </span>
        </button>
      ))}
    </div>
  ) : null;

  return { palette, onKeyDown };
}
