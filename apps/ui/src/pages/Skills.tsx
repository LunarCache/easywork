import { useCallback, useEffect, useState } from "react";
import type { Skill } from "@ew/shared";
import { getClient } from "../lib/client.js";
import { SparkIcon, FolderIcon, PlusIcon } from "../icons.js";

export function Skills() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [dir, setDir] = useState("");
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState("");

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

  return (
    <div className="page">
      <div className="page-head">
        <span className="ico">
          <SparkIcon size={20} />
        </span>
        <div>
          <h2>Skills</h2>
          <p className="lead">
            放入 skills 目录的 SKILL.md 自动发现（渐进披露：系统提示只放目录，模型按需 open_skill 加载全文）。
          </p>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button className="btn-ghost btn" onClick={() => void openDir()}>
            <FolderIcon size={14} /> 打开目录
          </button>
          <button className="btn" onClick={() => void newTemplate()}>
            <PlusIcon size={14} /> 新建 SKILL.md
          </button>
        </div>
      </div>
      {note && <div className="note">{note}</div>}
      {dir && <div className="sub" style={{ marginBottom: 12 }}>技能目录：<code>{dir}</code></div>}

      {!loading && skills.length === 0 && (
        <div className="empty-models">
          <SparkIcon size={26} />
          <p>还没有 Skills</p>
          <span>把 SKILL.md（含 name / description / whenToUse 的 frontmatter）放进技能目录后自动出现。</span>
        </div>
      )}

      <div className="skill-grid">
        {skills.map((s) => (
          <div key={s.id} className="skill-card">
            <div className="skill-name">{s.frontmatter.name}</div>
            {s.frontmatter.description && <div className="skill-desc">{s.frontmatter.description}</div>}
            {s.frontmatter.whenToUse && (
              <div className="skill-when">
                <span>何时使用</span>
                {s.frontmatter.whenToUse}
              </div>
            )}
            <div className="skill-meta">
              {s.frontmatter.version ? `v${s.frontmatter.version} · ` : ""}
              {s.scripts.length > 0 ? `${s.scripts.length} 脚本 · ` : ""}
              {s.resources.length > 0 ? `${s.resources.length} 资源` : "无附加资源"}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
