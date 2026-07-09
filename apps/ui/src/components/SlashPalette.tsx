// 斜杠命令自动补全面板 + 键盘交互 hook（Chat / Workspace composer 共用）。
// 两阶段：① 命令名（/think /model /compact，按前缀过滤）→ 选无参命令即执行，选带参命令补「/x 」进参数阶段；
//         ② 参数（think 4 档 / model 先 provider 后模型）→ 选中即执行并清空输入。
import { useCallback, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import type { ThinkLevel } from "@ew/shared";
import type { ModelSourceInfo } from "@ew/sdk";
import { modelLabel } from "../lib/agent-stream.js";
import { matchCmds, parseCmd, slashQuery, THINK_LEVELS, THINK_LABEL, THINK_META } from "../lib/slash.js";
import { BrainIcon, CheckIcon, ClockIcon, EnterIcon, ThinkIcon } from "../icons.js";

type SlashIcon = typeof BrainIcon;

export interface SlashHandlers {
  models: string[];
  modelSources?: ModelSourceInfo[];
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

interface ModelProviderGroup {
  key: string;
  token: string;
  label: string;
  models: string[];
}

function sourceLabel(source: ModelSourceInfo | undefined): string {
  if (!source) return "模型";
  if (source.kind === "local") return "本地模型";
  if (source.kind === "provider") return source.label || source.providerId || "云端 Provider";
  return source.label || "其它模型";
}

function sourceKey(source: ModelSourceInfo | undefined): string {
  if (!source) return "models";
  if (source.kind === "provider") return `provider:${source.providerId ?? source.label}`;
  return source.kind;
}

function baseTokenForSource(source: ModelSourceInfo | undefined): string {
  if (!source) return "models";
  if (source.kind === "local") return "local";
  if (source.kind === "engine") return "other";
  return (source.providerId || source.label || "provider").trim().replace(/\s+/g, "-");
}

function modelArgRaw(input: string): string {
  const body = input.replace(/^\//, "");
  const sp = body.indexOf(" ");
  return sp === -1 ? "" : body.slice(sp + 1);
}

function splitModelArg(raw: string): { providerQuery: string; providerToken?: string; modelQuery?: string } {
  const value = raw.trimStart();
  const tokenMatch = value.match(/^(\S+)/);
  if (!tokenMatch) return { providerQuery: "" };
  const token = tokenMatch[1]!;
  const rest = value.slice(token.length);
  if (/^\s/.test(rest)) {
    return { providerQuery: token, providerToken: token, modelQuery: rest.trimStart() };
  }
  return { providerQuery: value.trim() };
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
  const sourceByModel = useMemo(() => new Map((h.modelSources ?? []).map((source) => [source.id, source])), [h.modelSources]);
  const modelGroups = useMemo<ModelProviderGroup[]>(() => {
    const byKey = new Map<string, ModelProviderGroup>();
    const usedTokens = new Set<string>();
    const uniqueToken = (base: string): string => {
      let token = base || "models";
      let i = 2;
      while (usedTokens.has(token.toLowerCase())) {
        token = `${base}-${i}`;
        i += 1;
      }
      usedTokens.add(token.toLowerCase());
      return token;
    };
    for (const model of h.models) {
      const source = sourceByModel.get(model);
      const key = sourceKey(source);
      let group = byKey.get(key);
      if (!group) {
        group = {
          key,
          token: uniqueToken(baseTokenForSource(source)),
          label: sourceLabel(source),
          models: [],
        };
        byKey.set(key, group);
      }
      group.models.push(model);
    }
    return [...byKey.values()];
  }, [h.models, sourceByModel]);
  const modelTitle = useCallback((model: string) => modelLabel(sourceByModel.get(model)?.modelId ?? model), [sourceByModel]);
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
            value: modelTitle(h.currentModel),
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
      const parsed = splitModelArg(modelArgRaw(input));
      const onlyGroup = modelGroups.length === 1 ? modelGroups[0] : undefined;
      const selectedGroup = parsed.providerToken
        ? modelGroups.find((group) => group.token.toLowerCase() === parsed.providerToken?.toLowerCase())
        : onlyGroup;
      if (!selectedGroup) {
        const q = parsed.providerQuery.toLowerCase();
        return modelGroups
          .filter((group) => (
            group.label.toLowerCase().includes(q)
            || group.token.toLowerCase().includes(q)
            || group.models.some((m) => modelTitle(m).toLowerCase().includes(q))
          ))
          .slice(0, 8)
          .map((group) => ({
            key: group.key,
            title: group.label,
            desc: `${group.models.length} 个模型`,
            cmd: "/model",
            value: group.models.includes(h.currentModel) ? "当前来源" : undefined,
            active: group.models.includes(h.currentModel),
            Icon: BrainIcon,
            run: () => setInput(`/model ${group.token} `),
          }));
      }
      const a = (parsed.providerToken ? parsed.modelQuery ?? "" : parsed.providerQuery).toLowerCase();
      return selectedGroup.models
        .filter((m) => {
          const source = sourceByModel.get(m);
          const rawId = source?.modelId ?? m;
          return modelTitle(m).toLowerCase().includes(a) || rawId.toLowerCase().includes(a);
        })
        .slice(0, 8)
        .map((m) => ({
          key: m,
          title: modelTitle(m),
          desc: selectedGroup.label,
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
  }, [q, input, h, setInput, modelTitle, modelGroups, sourceByModel]);

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
    <div className="slash-pal" role="listbox" data-testid="slash-palette">
      <div className="slash-head">
        <div className="slash-breadcrumb">
          <span className="slash-kbd">/</span>
          <span className="slash-stage">
            {stage === "root"
              ? "命令"
              : stage === "model"
                ? splitModelArg(modelArgRaw(input)).providerToken ? "选择模型" : "选择模型来源"
                : "正在设置 /think"}
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
          data-testid={`slash-item-${it.key}`}
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
