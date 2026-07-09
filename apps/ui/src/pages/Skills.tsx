import { useCallback, useEffect, useMemo, useState } from "react";
import type { Skill, SkillSource } from "@ew/shared";
import { getClient } from "../lib/client.js";
import { ConfigEmptyState, ConfigToolbar } from "../components/ConfigPrimitives.js";
import { loadDisabledSkills, saveDisabledSkills } from "../lib/prefs.js";
import { SparkIcon, FolderIcon, PlusIcon, ArrowLeftIcon, CheckIcon, XIcon } from "../icons.js";

function shortPath(p: string): string {
  const normalized = p.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 2) return normalized;
  return `…/${parts.slice(-2).join("/")}`;
}

function sourceSubtitle(source: SkillSource): string {
  const path = shortPath(source.dir);
  if (!path) return "全局技能目录";
  switch (source.kind) {
    case "builtin":
      return "EasyWork 内置全局技能";
    case "agents":
      return `pi 标准全局目录 · ${path}`;
    default:
      return `全局技能目录 · ${path}`;
  }
}

export function Skills() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [sources, setSources] = useState<SkillSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState("");
  const [disabled, setDisabled] = useState<string[]>(() => loadDisabledSkills());
  const [detail, setDetail] = useState<{ skill: Skill; body: string | null } | null>(null);
  const [creating, setCreating] = useState(false); // 新建技能的行内输入（Tauri webview 无 window.prompt）
  const [newName, setNewName] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const info = await getClient().skillsInfo();
      setSkills(info.skills);
      setSources(info.sources ?? []);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openDir = async () => {
    try {
      await getClient().openSkillsDir();
    } catch (e) {
      setNote(`打开失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const newTemplate = () => {
    setNewName("my-skill");
    setCreating(true);
  };
  const cancelTemplate = () => {
    setCreating(false);
    setNewName("");
  };
  const confirmTemplate = async () => {
    const name = newName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!name) return; // 空名：保持输入态
    setCreating(false);
    setNewName("");
    try {
      const r = await getClient().createSkillTemplate(name);
      setNote(`已创建模板：${r.file}`);
      await refresh();
    } catch (e) {
      setNote(`创建失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const toggle = (name: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setDisabled((cur) => {
      const next = cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name];
      saveDisabledSkills(next);
      return next;
    });
  };

  const openDetail = async (s: Skill) => {
    setDetail({ skill: s, body: null });
    try {
      const r = await getClient().skillBody(s.id);
      setDetail({ skill: s, body: r.body });
    } catch {
      setDetail({ skill: s, body: "（无法读取 SKILL.md）" });
    }
  };

  const sourceGroups = useMemo(() => {
    const known = new Set(sources.map((source) => source.id));
    const groups = sources.map((source) => ({
      source,
      skills: skills.filter((skill) => skill.source?.id === source.id),
    }));
    const unknownSkills = skills.filter((skill) => !known.has(skill.source?.id ?? ""));
    if (unknownSkills.length > 0) {
      groups.push({
        source: {
          id: "unknown",
          label: "其他全局目录",
          kind: "custom",
          dir: "",
        },
        skills: unknownSkills,
      });
    }
    return groups;
  }, [skills, sources]);

  // 详情：SKILL.md 正文。
  if (detail) {
    const fm = detail.skill.frontmatter;
    return (
      <div className="page skills-page">
        <div className="skill-detail-head">
          <button className="files-back" data-testid="skills-detail-back" onClick={() => setDetail(null)}>
            <ArrowLeftIcon size={15} /> 返回
          </button>
          <span className="skill-detail-name" data-testid="skills-detail-name">{fm.name}</span>
          <span className="bar-spacer" />
          <button className="set-btn secondary" onClick={() => void openDir()}>
            <FolderIcon size={14} /> 打开目录
          </button>
        </div>
        {fm.description && <p className="skill-detail-desc">{fm.description}</p>}
        <pre className="skill-detail-body">{detail.body ?? "加载中…"}</pre>
      </div>
    );
  }

  return (
    <div className="page skills-page">
      <ConfigToolbar
        actions={(
          <>
            <button className="set-btn ghost soft icon" title="打开技能目录" onClick={() => void openDir()}>
              <FolderIcon size={16} />
            </button>
            <button className="set-btn secondary icon" data-testid="skills-new-button" title="新建技能" onClick={newTemplate}>
              <PlusIcon size={16} />
            </button>
          </>
        )}
      >
        <p className="skills-lead">{loading ? "正在扫描全局技能…" : `已发现 ${skills.length} 个全局技能`}</p>
      </ConfigToolbar>
      {creating && (
        <div className="skills-new" data-testid="skills-new-inline">
          <PlusIcon size={14} />
          <input
            autoFocus
            data-testid="skills-new-input"
            placeholder="技能名（英文 / 数字 / 连字符）"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void confirmTemplate();
              else if (e.key === "Escape") cancelTemplate();
            }}
          />
          <button data-testid="skills-new-submit" title="创建" onClick={() => void confirmTemplate()}>
            <CheckIcon size={15} />
          </button>
          <button data-testid="skills-new-cancel" title="取消" onClick={cancelTemplate}>
            <XIcon size={15} />
          </button>
        </div>
      )}
      {note && <div className="note">{note}</div>}

      {!loading && sourceGroups.length === 0 ? (
        <ConfigEmptyState
          icon={<SparkIcon size={24} />}
          title="还没有发现技能"
          description="可以新建模板，或把带 SKILL.md 的目录放入技能目录。"
        />
      ) : (
        <div className="skill-sources">
          {sourceGroups.map(({ source, skills: groupSkills }) => (
            <section key={source.id} className="skill-source" data-testid={`skills-source-${source.id}`}>
              <div className="skill-source-head">
                <div className="skill-source-title">
                  <strong>{source.label}</strong>
                  <span>{sourceSubtitle(source)}</span>
                </div>
                <span className="set-pill ghost" data-testid={`skills-source-count-${source.id}`}>{groupSkills.length} 个</span>
              </div>
              {groupSkills.length === 0 ? (
                <div className="skill-source-empty">此全局目录暂无技能</div>
              ) : (
                <div className="skill-list">
                  {groupSkills.map((s) => {
                    const name = s.frontmatter.name;
                    const on = !disabled.includes(name);
                    return (
                      <div key={s.id} className="skills-card" data-testid={`skill-card-${s.id}`} onClick={() => void openDetail(s)}>
                        <span className="skill-ico">
                          <SparkIcon size={18} />
                        </span>
                        <div className="skill-body">
                          <div className="skill-name">
                            {name}
                            {s.frontmatter.version && <span className="set-pill">v{s.frontmatter.version}</span>}
                            {s.scripts.length > 0 && <span className="set-pill">{s.scripts.length} 脚本</span>}
                          </div>
                          <div className="skill-desc">
                            {s.frontmatter.description || s.frontmatter.whenToUse || "（无描述）"}
                          </div>
                        </div>
                        <div className="skill-actions" onClick={(e) => e.stopPropagation()}>
                          <span className={`skill-state ${on ? "on" : ""}`} data-testid={`skill-status-${s.id}`}>
                            {on ? "已启用" : "已关闭"}
                          </span>
                          <button
                            className={`set-toggle ${on ? "on" : ""}`}
                            data-testid={`skill-toggle-${s.id}`}
                            title={on ? "已启用（点击关闭）" : "已关闭（点击启用）"}
                            aria-label={on ? `关闭 ${name}` : `启用 ${name}`}
                            aria-pressed={on}
                            onClick={(e) => toggle(name, e)}
                          >
                            <span />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
