import { useCallback, useEffect, useState } from "react";
import type { Skill } from "@ew/shared";
import { getClient } from "../lib/client.js";
import { loadDisabledSkills, saveDisabledSkills } from "../lib/prefs.js";
import { SparkIcon, FolderIcon, PlusIcon, ArrowLeftIcon, CheckIcon, XIcon } from "../icons.js";

function skillSourceLabel(dir: string): string {
  const normalized = dir.replace(/\\/g, "/");
  if (normalized.includes("/.codex/plugins/cache/")) return "Codex 插件";
  if (normalized.includes("/.codex/skills/.system/")) return "Codex 系统";
  if (normalized.includes("/.codex/skills/")) return "Codex";
  if (normalized.includes("/.agents/skills/")) return "Agents";
  return "应用目录";
}

function shortPath(p: string): string {
  const normalized = p.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 2) return normalized;
  return `…/${parts.slice(-2).join("/")}`;
}

export function Skills() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [skillsDir, setSkillsDir] = useState("");
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
      setSkillsDir(info.dir);
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
      <div className="skills-head">
        <p className="skills-lead">{loading ? "正在扫描技能…" : `已发现 ${skills.length} 个技能`}</p>
        {skillsDir && <span className="set-pill ghost" title={skillsDir}>主目录 {shortPath(skillsDir)}</span>}
        <span className="bar-spacer" />
        <button className="set-btn ghost soft icon" title="打开技能目录" onClick={() => void openDir()}>
          <FolderIcon size={16} />
        </button>
        <button className="set-btn secondary icon" data-testid="skills-new-button" title="新建技能" onClick={newTemplate}>
          <PlusIcon size={16} />
        </button>
      </div>
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

      {!loading && skills.length === 0 ? (
        <div className="empty-models">
          <SparkIcon size={24} />
          <p>还没有发现技能</p>
          <span>可以新建模板，或把带 SKILL.md 的目录放入技能目录。</span>
        </div>
      ) : (
      <div className="skill-list">
        {skills.map((s) => {
          const name = s.frontmatter.name;
          const on = !disabled.includes(name);
          return (
            <div key={s.id} className="skill-card" data-testid={`skill-card-${s.id}`} onClick={() => void openDetail(s)}>
              <span className="skill-ico">
                <SparkIcon size={18} />
              </span>
              <div className="skill-body">
                <div className="skill-name">
                  {name}
                  {s.frontmatter.version && <span className="set-pill">v{s.frontmatter.version}</span>}
                  {s.scripts.length > 0 && <span className="set-pill">{s.scripts.length} 脚本</span>}
                  <span className="set-pill ghost">{skillSourceLabel(s.dir)}</span>
                </div>
                <div className="skill-desc">
                  {s.frontmatter.description || s.frontmatter.whenToUse || "（无描述）"}
                </div>
              </div>
              <button
                className={`set-toggle ${on ? "on" : ""}`}
                title={on ? "已启用（点击关闭）" : "已关闭（点击启用）"}
                aria-pressed={on}
                onClick={(e) => toggle(name, e)}
              >
                <span />
              </button>
            </div>
          );
        })}
      </div>
      )}
    </div>
  );
}
