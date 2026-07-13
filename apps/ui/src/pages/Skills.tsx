import { useCallback, useEffect, useMemo, useState } from "react";
import type { LearnedSkill, Project, Skill, SkillCandidate, SkillLearningSettings, SkillLearningStatus, SkillSource } from "@ew/shared";
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
  const [candidates, setCandidates] = useState<SkillCandidate[]>([]);
  const [learned, setLearned] = useState<LearnedSkill[]>([]);
  const [learningSettings, setLearningSettings] = useState<SkillLearningSettings | null>(null);
  const [learningStatus, setLearningStatus] = useState<SkillLearningStatus | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [tab, setTab] = useState<"active" | "pending" | "archived">("active");
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState("");
  const [disabled, setDisabled] = useState<string[]>(() => loadDisabledSkills());
  const [detail, setDetail] = useState<{ skill: Skill; body: string | null } | null>(null);
  const [candidateDetail, setCandidateDetail] = useState<SkillCandidate | null>(null);
  const [candidateDraft, setCandidateDraft] = useState("");
  const [candidateDiff, setCandidateDiff] = useState("");
  const [creating, setCreating] = useState(false); // 新建技能的行内输入（Tauri webview 无 window.prompt）
  const [newName, setNewName] = useState("");
  const [learning, setLearning] = useState(false);
  const [learnKind, setLearnKind] = useState<"text" | "path" | "url" | "conversation">("text");
  const [learnValue, setLearnValue] = useState("");
  const [learnWorkspaceId, setLearnWorkspaceId] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const info = await getClient().skillsInfo();
      setSkills(info.skills);
      setSources(info.sources ?? []);
      setCandidates(await getClient().listSkillCandidates());
      setLearned(await getClient().listLearnedSkills());
      const learning = await getClient().skillLearningStatus();
      setLearningSettings(learning.settings);
      setLearningStatus(learning.status);
      setProjects(await getClient().listProjects());
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

  const openCandidate = (candidate: SkillCandidate) => {
    setCandidateDetail(candidate);
    setCandidateDraft(candidate.proposedSkillMd);
    setCandidateDiff("");
    void getClient().getSkillCandidateDiff(candidate.id).then(setCandidateDiff).catch(() => {});
  };

  const saveCandidate = async () => {
    if (!candidateDetail) return;
    try {
      const next = await getClient().reviseSkillCandidate(candidateDetail.id, { proposedSkillMd: candidateDraft });
      setCandidateDetail(next);
      setCandidateDiff(await getClient().getSkillCandidateDiff(candidateDetail.id));
      setNote("候选内容和验证报告已更新。");
      await refresh();
    } catch (error) {
      setNote(`保存失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const approveCandidate = async () => {
    if (!candidateDetail) return;
    try {
      await getClient().approveSkillCandidate(candidateDetail.id);
      setCandidateDetail(null);
      setTab("active");
      setNote("Skill 已批准并激活；将在下一轮 Agent 会话中生效。");
      await refresh();
    } catch (error) {
      setNote(`批准失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const rejectCandidate = async () => {
    if (!candidateDetail) return;
    await getClient().rejectSkillCandidate(candidateDetail.id, "用户在 Skills 设置中拒绝");
    setCandidateDetail(null);
    setNote("候选已拒绝，活跃 Skill 未改变。");
    await refresh();
  };

  const changeCandidateScope = async (scope: "global" | "workspace", workspaceId?: string) => {
    if (!candidateDetail) return;
    try {
      const next = await getClient().changeSkillCandidateScope(candidateDetail.id, scope, workspaceId);
      setCandidateDetail(next);
      await refresh();
    } catch (error) {
      setNote(`切换作用域失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const beginLearning = async () => {
    try {
      const prepared = await getClient().prepareSkillLearning({
        kind: learnKind,
        ...(learnValue.trim() ? { value: learnValue.trim() } : {}),
        ...(learnWorkspaceId ? { workspaceId: learnWorkspaceId } : {}),
      });
      setLearning(false);
      window.dispatchEvent(new CustomEvent("ew:learn-skill-compose", { detail: prepared }));
    } catch (error) {
      setNote(`学习准备失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const updateLearning = async (patch: Partial<SkillLearningSettings>) => {
    const result = await getClient().updateSkillLearningSettings(patch);
    setLearningSettings(result.settings);
  };

  const reviewNow = async () => {
    try {
      const status = await getClient().reviewSkillLearning();
      setLearningStatus(status);
      setNote(status.lastResult === "candidate" ? "已产生待审核 Skill Candidate。" : status.lastResult === "nothing" ? "检查完成：Nothing to learn。" : "检查完成。" );
      await refresh();
    } catch (error) {
      setNote(`检查失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const archiveLearned = async (id: string) => {
    try {
      await getClient().archiveLearnedSkill(id);
      await refresh();
    } catch (error) {
      setNote(`归档失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const restoreLearned = async (id: string) => {
    await getClient().restoreLearnedSkill(id);
    await refresh();
  };

  const rollbackLatest = async (id: string) => {
    try {
      const snapshots = await getClient().learnedSkillSnapshots(id);
      if (!snapshots[0]) {
        setNote("这个 learned Skill 还没有可回滚快照。");
        return;
      }
      await getClient().rollbackLearnedSkill(id, snapshots[0].id);
      setNote(`已回滚到快照：${snapshots[0].reason}`);
      await refresh();
    } catch (error) {
      setNote(`回滚失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const curateLearned = async () => {
    try {
      const { report } = await getClient().curateLearnedSkills();
      setNote(`维护报告：${report.messages.join("；")}`);
      await refresh();
    } catch (error) {
      setNote(`维护失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const consolidateLearned = async () => {
    try {
      const status = await getClient().consolidateLearnedSkills();
      setLearningStatus(status);
      setNote(status.lastResult === "candidate" ? "已生成待审核 consolidation patch。" : "Consolidation dry-run 完成，没有直接修改 Skill。");
      await refresh();
    } catch (error) {
      setNote(`Consolidation 失败：${error instanceof Error ? error.message : String(error)}`);
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

  if (candidateDetail) {
    return (
      <div className="page skills-page" data-testid="skill-candidate-detail">
        <div className="skill-detail-head">
          <button className="files-back" onClick={() => setCandidateDetail(null)}>
            <ArrowLeftIcon size={15} /> 返回待审核
          </button>
          <span className="skill-detail-name">{candidateDetail.name}</span>
          <span className="set-pill">{candidateDetail.scope === "global" ? "全局" : "工作区"}</span>
          <span className="bar-spacer" />
          <button className="set-btn ghost soft" onClick={() => void rejectCandidate()}>拒绝</button>
          <button className="set-btn secondary" onClick={() => void saveCandidate()}>保存修订</button>
          <button className="set-btn primary" data-testid="skill-candidate-approve" onClick={() => void approveCandidate()} disabled={!candidateDetail.validation.valid}>批准并激活</button>
        </div>
        <p className="skill-detail-desc">{candidateDetail.reason}</p>
        <div className="row gap">
          <label>作用域</label>
          <select
            value={candidateDetail.scope === "global" ? "global" : candidateDetail.workspaceId ?? "workspace"}
            onChange={(event) => {
              const value = event.target.value;
              if (value === "global") void changeCandidateScope("global");
              else void changeCandidateScope("workspace", value);
            }}
          >
            <option value="global">全局</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </div>
        <div className="note">来源：{candidateDetail.sourceThreadIds.join("、")} · {candidateDetail.evidence.map((entry) => entry.summary).join("；")}</div>
        {candidateDetail.validation.findings.length > 0 && (
          <div className="note">{candidateDetail.validation.findings.map((finding) => `${finding.severity}: ${finding.message}`).join("；")}</div>
        )}
        <textarea className="skill-detail-body" data-testid="skill-candidate-editor" value={candidateDraft} onChange={(event) => setCandidateDraft(event.target.value)} />
        {candidateDiff && <pre className="skill-detail-body" data-testid="skill-candidate-diff">{candidateDiff}</pre>}
      </div>
    );
  }

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
            <button className="set-btn secondary" data-testid="skills-learn-button" onClick={() => setLearning(true)}>
              <SparkIcon size={15} /> 学习 Skill
            </button>
            <button className="set-btn secondary icon" data-testid="skills-new-button" title="新建技能" onClick={newTemplate}>
              <PlusIcon size={16} />
            </button>
          </>
        )}
      >
        <div className="row gap">
          <button className={`set-btn ${tab === "active" ? "primary" : "ghost soft"}`} onClick={() => setTab("active")}>已启用</button>
          <button className={`set-btn ${tab === "pending" ? "primary" : "ghost soft"}`} data-testid="skills-tab-pending" onClick={() => setTab("pending")}>待审核 · {candidates.filter((candidate) => candidate.status === "pending").length}</button>
          <button className={`set-btn ${tab === "archived" ? "primary" : "ghost soft"}`} onClick={() => setTab("archived")}>已归档</button>
        </div>
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
      {learningSettings && (
        <div className="row gap" data-testid="skill-learning-controls">
          <label className="row gap">
            <input type="checkbox" checked={learningSettings.enabled} onChange={(event) => void updateLearning({ enabled: event.target.checked })} />
            自动学习
          </label>
          <label className="row gap">
            <input type="checkbox" checked={learningSettings.automaticReview} onChange={(event) => void updateLearning({ automaticReview: event.target.checked })} />
            自动检查
          </label>
          <label className="row gap">
            最少工具调用
            <input
              type="number"
              min={1}
              max={100}
              value={learningSettings.minToolCalls}
              onChange={(event) => {
                const value = Number(event.target.value);
                if (Number.isInteger(value) && value >= 1 && value <= 100) void updateLearning({ minToolCalls: value });
              }}
              style={{ width: 64 }}
            />
          </label>
          <label className="row gap">
            学习模型
            <input
              value={learningSettings.learnerModel ?? ""}
              placeholder="Auto / 当前模型"
              onChange={(event) => void updateLearning({ learnerModel: event.target.value.trim() || undefined })}
            />
          </label>
          <label className="row gap">
            <input type="checkbox" checked={learningSettings.consolidationEnabled} onChange={(event) => void updateLearning({ consolidationEnabled: event.target.checked })} />
            LLM consolidation（仅提案）
          </label>
          <button className="set-btn ghost soft" onClick={() => void reviewNow()} disabled={learningStatus?.running}>立即检查</button>
          <button className="set-btn ghost soft" data-testid="skill-curate-button" onClick={() => void curateLearned()}>执行维护</button>
          <button className="set-btn ghost soft" disabled={!learningSettings.consolidationEnabled} onClick={() => void consolidateLearned()}>Consolidation dry-run</button>
          {learningStatus?.lastResult && <span className="set-pill">上次：{learningStatus.lastResult}</span>}
        </div>
      )}
      {learning && (
        <div className="confirm-mask" onClick={() => setLearning(false)}>
          <div className="confirm-box wide" data-testid="skills-learn-dialog" onClick={(event) => event.stopPropagation()}>
            <div className="confirm-title">学习 Skill</div>
            <div className="mem-add-pickers">
              <select value={learnKind} onChange={(event) => setLearnKind(event.target.value as typeof learnKind)}>
                <option value="text">文本说明</option>
                <option value="path">工作区文件</option>
                <option value="url">URL</option>
              </select>
              <select value={learnWorkspaceId} onChange={(event) => setLearnWorkspaceId(event.target.value)}>
                <option value="">全局 / 当前对话</option>
                {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
            </div>
            <textarea
              className="mem-add-textarea"
              value={learnValue}
              onChange={(event) => setLearnValue(event.target.value)}
              placeholder={learnKind === "path" ? "相对工作区路径" : learnKind === "url" ? "https://…" : "描述要学习的可复用流程"}
            />
            <div className="confirm-actions">
              <span className="ad-spacer" />
              <button className="set-btn ghost soft" onClick={() => setLearning(false)}>取消</button>
              <button className="set-btn primary" data-testid="skills-learn-submit" onClick={() => void beginLearning()} disabled={!learnValue.trim()}>进入 Agent 学习</button>
            </div>
          </div>
        </div>
      )}

      {tab === "pending" ? (
        <div className="skill-list" data-testid="skill-candidate-list">
          {candidates.filter((candidate) => candidate.status === "pending").map((candidate) => (
            <div key={candidate.id} className="skills-card" data-testid={`skill-candidate-${candidate.id}`} onClick={() => openCandidate(candidate)}>
              <span className="skill-ico"><SparkIcon size={18} /></span>
              <div className="skill-body">
                <div className="skill-name">{candidate.name}<span className="set-pill">{candidate.scope === "global" ? "全局" : "工作区"}</span></div>
                <div className="skill-desc">{candidate.reason}</div>
              </div>
              <span className={`set-pill ${candidate.validation.valid ? "" : "warn"}`}>{candidate.validation.valid ? "验证通过" : "需修订"}</span>
            </div>
          ))}
          {!loading && candidates.every((candidate) => candidate.status !== "pending") && (
            <ConfigEmptyState icon={<SparkIcon size={24} />} title="没有待审核候选" description="自动学习与“学习 Skill”产生的候选会显示在这里。" />
          )}
        </div>
      ) : tab === "archived" ? (
        <div className="skill-list" data-testid="learned-skill-archive">
          {learned.filter((skill) => skill.state === "archived").map((skill) => (
            <div key={skill.id} className="skills-card">
              <span className="skill-ico"><SparkIcon size={18} /></span>
              <div className="skill-body"><div className="skill-name">{skill.name}</div><div className="skill-desc">已归档，可恢复 · 使用 {skill.uses} 次</div></div>
              <button className="set-btn secondary" onClick={() => void restoreLearned(skill.id)}>恢复</button>
            </div>
          ))}
          {learned.every((skill) => skill.state !== "archived") && <ConfigEmptyState icon={<SparkIcon size={24} />} title="暂无归档 Skill" description="可恢复的 learned Skills 会显示在这里。" />}
        </div>
      ) : !loading && sourceGroups.length === 0 ? (
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
                    const learnedSkill = learned.find((item) => item.path === s.dir);
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
                          {learnedSkill && <div className="skill-desc">学习来源 · 使用 {learnedSkill.uses} · 成功 {learnedSkill.successes} · 失败 {learnedSkill.failures} · 修正 {learnedSkill.corrections}</div>}
                        </div>
                        <div className="skill-actions" onClick={(e) => e.stopPropagation()}>
                          {learnedSkill && (
                            <>
                              <button className="set-btn ghost soft" onClick={() => void getClient().pinLearnedSkill(learnedSkill.id, !learnedSkill.pinned).then(refresh)}>{learnedSkill.pinned ? "取消固定" : "固定"}</button>
                              <button className="set-btn ghost soft" onClick={() => void rollbackLatest(learnedSkill.id)}>回滚</button>
                              <button className="set-btn ghost soft" disabled={learnedSkill.pinned} onClick={() => void archiveLearned(learnedSkill.id)}>归档</button>
                            </>
                          )}
                          {!on && <span className="skill-state" data-testid={`skill-status-${s.id}`}>已关闭</span>}
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
