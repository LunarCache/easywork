import { useCallback, useEffect, useState } from "react";
import type { Skill } from "@ew/shared";
import { getClient } from "../lib/client.js";
import { loadDisabledSkills, saveDisabledSkills } from "../lib/prefs.js";
import { SparkIcon, FolderIcon, PlusIcon } from "../icons.js";

export function Skills() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [dir, setDir] = useState("");
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState("");
  const [disabled, setDisabled] = useState<string[]>(() => loadDisabledSkills());

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const info = await getClient().skillsInfo();
      setSkills(info.skills);
      setDir(info.dir);
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

  const newTemplate = async () => {
    const name = window.prompt("新技能名称（英文/数字/连字符）", "my-skill");
    if (!name) return;
    try {
      const r = await getClient().createSkillTemplate(name);
      setNote(`已创建模板：${r.file}`);
      await refresh();
    } catch (e) {
      setNote(`创建失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const toggle = (name: string) => {
    setDisabled((cur) => {
      const next = cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name];
      saveDisabledSkills(next);
      return next;
    });
  };

  return (
    <div className="page">
      <div className="set-head">
        <div>
          <h3>Skills</h3>
          <p>放入技能目录的 SKILL.md 自动发现；关掉的技能不再提供给模型（新会话生效）。</p>
        </div>
        <div style={{ display: "flex", gap: 8, flex: "none" }}>
          <button className="set-add" onClick={() => void openDir()}>
            <FolderIcon size={14} /> 打开目录
          </button>
          <button className="set-add" onClick={() => void newTemplate()}>
            <PlusIcon size={14} /> 新建 SKILL.md
          </button>
        </div>
      </div>
      {note && <div className="note">{note}</div>}

      {!loading && skills.length === 0 && (
        <div className="empty-models">
          <SparkIcon size={26} />
          <p>还没有 Skills</p>
          <span>把 SKILL.md（含 name / description / whenToUse 的 frontmatter）放进技能目录后自动出现。</span>
        </div>
      )}

      <div className="set-list">
        {skills.map((s) => {
          const name = s.frontmatter.name;
          const on = !disabled.includes(name);
          return (
            <div key={s.id} className="set-row">
              <span className="set-row-ico">
                <SparkIcon size={17} />
              </span>
              <div className="set-row-body">
                <div className="set-row-name">
                  {name}
                  {s.frontmatter.version && <span className="set-pill">v{s.frontmatter.version}</span>}
                  {s.scripts.length > 0 && <span className="set-pill">{s.scripts.length} 脚本</span>}
                </div>
                <div className="set-row-desc" title={s.frontmatter.description || s.frontmatter.whenToUse}>
                  {s.frontmatter.description || s.frontmatter.whenToUse || "（无描述）"}
                </div>
              </div>
              <button
                className={`set-toggle ${on ? "on" : ""}`}
                title={on ? "已启用（点击关闭）" : "已关闭（点击启用）"}
                aria-pressed={on}
                onClick={() => toggle(name)}
              >
                <span />
              </button>
            </div>
          );
        })}
      </div>

      {dir && (
        <div className="sub" style={{ marginTop: 14 }}>
          技能目录：<code>{dir}</code>
        </div>
      )}
    </div>
  );
}
