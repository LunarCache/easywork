import { useCallback, useEffect, useMemo, useState } from "react";
import type { LearnedSkill, Project, Skill, SkillCandidate, SkillLearningSettings, SkillLearningStatus, SkillSnapshot, SkillSource } from "@ew/shared";
import { getClient } from "../lib/client.js";
import { ConfigDisclosure, ConfigEmptyState, ConfigToolbar } from "../components/ConfigPrimitives.js";
import { loadDisabledSkills, saveDisabledSkills } from "../lib/prefs.js";
import { SparkIcon, FolderIcon, PlusIcon, ArrowLeftIcon, CheckIcon, XIcon, ChevronDownIcon } from "../icons.js";
import { deriveSkillAttention } from "../components/SkillAttentionBadge.js";

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

function notifySkillAttentionChanged(attention: { pending: number; error: boolean }): void {
  window.dispatchEvent(new CustomEvent("ew:skill-attention-changed", { detail: attention }));
}

export function Skills({ active = true }: { active?: boolean }) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [sources, setSources] = useState<SkillSource[]>([]);
  const [candidates, setCandidates] = useState<SkillCandidate[]>([]);
  const [learned, setLearned] = useState<LearnedSkill[]>([]);
  const [learningSettings, setLearningSettings] = useState<SkillLearningSettings | null>(null);
  const [learningStatus, setLearningStatus] = useState<SkillLearningStatus | null>(null);
  const [learningConfigOpen, setLearningConfigOpen] = useState(false);
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
  const [feedback, setFeedback] = useState<{
    learned: LearnedSkill;
    outcome: "success" | "failure" | "correction";
    summary: string;
    sourceThreadId: string;
    proposedSkillMd: string;
  } | null>(null);
  const [feedbackBusy, setFeedbackBusy] = useState(false);
  const [snapshots, setSnapshots] = useState<{ learned: LearnedSkill; items: SkillSnapshot[]; selectedId: string } | null>(null);
  const [snapshotsBusy, setSnapshotsBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const info = await getClient().skillsInfo();
      setSkills(info.skills);
      setSources(info.sources ?? []);
      const nextCandidates = await getClient().listSkillCandidates();
      setCandidates(nextCandidates);
      setLearned(await getClient().listLearnedSkills());
      const learning = await getClient().skillLearningStatus();
      setLearningSettings(learning.settings);
      setLearningStatus(learning.status);
      setProjects(await getClient().listProjects());
      notifySkillAttentionChanged(deriveSkillAttention(nextCandidates, learning.status));
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

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

  const openSourceThread = (sourceThreadId: string) => {
    window.dispatchEvent(new CustomEvent("ew:open-source-thread", { detail: { threadId: sourceThreadId } }));
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

  const openSnapshots = async (learned: LearnedSkill) => {
    setSnapshotsBusy(true);
    try {
      const items = await getClient().learnedSkillSnapshots(learned.id);
      setSnapshots({ learned, items, selectedId: items[0]?.id ?? "" });
    } catch (error) {
      setNote(`读取版本失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSnapshotsBusy(false);
    }
  };

  const rollbackSnapshot = async () => {
    if (!snapshots?.selectedId) return;
    setSnapshotsBusy(true);
    try {
      const selected = snapshots.items.find((item) => item.id === snapshots.selectedId);
      await getClient().rollbackLearnedSkill(snapshots.learned.id, snapshots.selectedId);
      setSnapshots(null);
      setNote(`已回滚到快照：${selected?.reason ?? snapshots.selectedId}`);
      await refresh();
    } catch (error) {
      setNote(`回滚失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSnapshotsBusy(false);
    }
  };

  const openFeedback = async (learnedSkill: LearnedSkill, skill: Skill) => {
    let body = "";
    try {
      body = (await getClient().skillBody(skill.id)).body;
    } catch {
      /* correction editor remains empty when the package cannot be read */
    }
    setFeedback({ learned: learnedSkill, outcome: "success", summary: "", sourceThreadId: "", proposedSkillMd: body });
  };

  const submitFeedback = async () => {
    if (!feedback || !feedback.summary.trim()) return;
    setFeedbackBusy(true);
    try {
      const result = await getClient().recordLearnedSkillFeedback(feedback.learned.id, {
        outcome: feedback.outcome,
        summary: feedback.summary.trim(),
        ...(feedback.sourceThreadId.trim() ? { sourceThreadId: feedback.sourceThreadId.trim() } : {}),
        ...(feedback.outcome === "correction" && feedback.proposedSkillMd.trim() ? { proposedSkillMd: feedback.proposedSkillMd } : {}),
      });
      setFeedback(null);
      if (result.candidate) {
        setTab("pending");
        setNote("修正已生成待审核 patch；当前 Skill 在批准前保持不变。");
      } else {
        setNote("反馈已记录，用于 learned Skill 的后续维护。");
      }
      await refresh();
    } catch (error) {
      setNote(`记录反馈失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setFeedbackBusy(false);
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
        <div className="skill-candidate-sources">
          <strong>来源对话</strong>
          {candidateDetail.sourceThreadIds.length === 0 ? <span className="skill-desc">独立候选，无来源对话</span> : candidateDetail.sourceThreadIds.map((sourceThreadId) => (
            <button
              key={sourceThreadId}
              className="set-btn ghost soft"
              data-testid={`skill-candidate-source-${sourceThreadId}`}
              title={sourceThreadId}
              onClick={() => openSourceThread(sourceThreadId)}
            >
              {sourceThreadId.slice(0, 12)}
            </button>
          ))}
        </div>
        {candidateDetail.evidence.length > 0 && (
          <div className="skill-evidence-list">
            {candidateDetail.evidence.map((entry, index) => (
              <button key={`${entry.sourceThreadId}-${index}`} onClick={() => openSourceThread(entry.sourceThreadId)}>
                <span>{entry.summary}</span>
                <small>打开来源对话 · {entry.sourceThreadId.slice(0, 12)}</small>
              </button>
            ))}
          </div>
        )}
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
      {learningStatus?.lastResult === "error" && (
        <div className="note danger" data-testid="skill-learning-error">自动学习上次检查失败：{learningStatus.lastError ?? "未知错误"}</div>
      )}
      {learningSettings && (
        <ConfigDisclosure
          className="skill-learning-panel"
          triggerClassName="skill-learning-summary"
          testId="skill-learning-controls"
          triggerTestId="skill-learning-summary"
          open={learningConfigOpen}
          onToggle={() => setLearningConfigOpen((value) => !value)}
          summary={(
            <>
              <span className="skill-learning-icon"><SparkIcon size={17} /></span>
              <span className="skill-learning-summary-copy">
                <strong>自动学习</strong>
                <span>
                  {learningSettings.enabled
                    ? learningSettings.automaticReview
                      ? `已开启 · 工具型任务达到 ${learningSettings.minToolCalls} 次调用后自动检查`
                      : "已开启 · 由你手动发起检查"
                    : "已关闭 · 仍可手动学习和维护 Skill"}
                </span>
              </span>
              <span className={`set-pill ${learningSettings.enabled ? "" : "ghost"}`}>
                {learningStatus?.running ? "运行中" : learningSettings.enabled ? "已启用" : "已关闭"}
              </span>
              {learningStatus?.lastResult && <span className="set-pill ghost">上次 {learningStatus.lastResult}</span>}
              <span className="config-disclosure-chevron"><ChevronDownIcon size={16} /></span>
            </>
          )}
        >
          <div className="skill-learning-config" data-testid="skill-learning-config">
              <div className="skill-learning-grid">
                <div className="skill-learning-setting">
                  <div className="skill-learning-setting-copy">
                    <strong>自动学习</strong>
                    <span>任务完成后记录可复用流程，但只生成待审核候选。</span>
                  </div>
                  <button
                    className={`set-toggle ${learningSettings.enabled ? "on" : ""}`}
                    type="button"
                    aria-label="自动学习"
                    aria-pressed={learningSettings.enabled}
                    onClick={() => void updateLearning({ enabled: !learningSettings.enabled })}
                  ><span /></button>
                </div>

                <div className="skill-learning-setting">
                  <div className="skill-learning-setting-copy">
                    <strong>自动检查</strong>
                    <span>在后台检查完成的工具型任务是否值得沉淀。</span>
                  </div>
                  <button
                    className={`set-toggle ${learningSettings.automaticReview ? "on" : ""}`}
                    type="button"
                    aria-label="自动检查"
                    aria-pressed={learningSettings.automaticReview}
                    onClick={() => void updateLearning({ automaticReview: !learningSettings.automaticReview })}
                  ><span /></button>
                </div>

                <label className="skill-learning-setting">
                  <span className="skill-learning-setting-copy">
                    <strong>检查阈值</strong>
                    <span>至少发生多少次工具调用才进入自动检查。</span>
                  </span>
                  <span className="skill-learning-number">
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={learningSettings.minToolCalls}
                      onChange={(event) => {
                        const value = Number(event.target.value);
                        if (Number.isInteger(value) && value >= 1 && value <= 100) void updateLearning({ minToolCalls: value });
                      }}
                    />
                    <span>次</span>
                  </span>
                </label>

                <label className="skill-learning-setting">
                  <span className="skill-learning-setting-copy">
                    <strong>学习模型</strong>
                    <span>留空时跟随当前会话模型。</span>
                  </span>
                  <input
                    className="skill-learning-model"
                    value={learningSettings.learnerModel ?? ""}
                    placeholder="自动 / 当前模型"
                    onChange={(event) => void updateLearning({ learnerModel: event.target.value.trim() || undefined })}
                  />
                </label>

                <div className="skill-learning-setting wide">
                  <div className="skill-learning-setting-copy">
                    <strong>智能合并提案</strong>
                    <span>对相似 Learned Skills 生成合并建议，不会直接改写已启用内容。</span>
                  </div>
                  <button
                    className={`set-toggle ${learningSettings.consolidationEnabled ? "on" : ""}`}
                    type="button"
                    aria-label="智能合并提案"
                    aria-pressed={learningSettings.consolidationEnabled}
                    onClick={() => void updateLearning({ consolidationEnabled: !learningSettings.consolidationEnabled })}
                  ><span /></button>
                </div>
              </div>

              <div className="skill-learning-actions">
                <span>{learningStatus?.running ? "正在检查最近任务…" : "所有自动结果都需要你在“待审核”中确认。"}</span>
                <button className="set-btn ghost soft" onClick={() => void reviewNow()} disabled={learningStatus?.running}>立即检查</button>
                <button className="set-btn ghost soft" data-testid="skill-curate-button" onClick={() => void curateLearned()}>执行维护</button>
                <button className="set-btn ghost soft" disabled={!learningSettings.consolidationEnabled} onClick={() => void consolidateLearned()}>预览合并方案</button>
              </div>
          </div>
        </ConfigDisclosure>
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
      {feedback && (
        <div className="confirm-mask" onClick={() => setFeedback(null)}>
          <div className="confirm-box wide skill-feedback-dialog" data-testid="learned-skill-feedback-dialog" onClick={(event) => event.stopPropagation()}>
            <div className="confirm-title">反馈 · {feedback.learned.name}</div>
            <div className="mem-add-pickers">
              <select
                data-testid="learned-skill-feedback-outcome"
                value={feedback.outcome}
                onChange={(event) => setFeedback((value) => value ? { ...value, outcome: event.target.value as typeof value.outcome } : value)}
              >
                <option value="success">使用成功</option>
                <option value="failure">使用失败</option>
                <option value="correction">需要修正</option>
              </select>
              <input
                value={feedback.sourceThreadId}
                placeholder="来源对话 ID（可选）"
                onChange={(event) => setFeedback((value) => value ? { ...value, sourceThreadId: event.target.value } : value)}
              />
            </div>
            <textarea
              className="mem-add-textarea"
              data-testid="learned-skill-feedback-summary"
              value={feedback.summary}
              placeholder="说明结果、失败原因或需要修正的地方"
              onChange={(event) => setFeedback((value) => value ? { ...value, summary: event.target.value } : value)}
            />
            {feedback.outcome === "correction" && (
              <>
                <div className="skill-feedback-hint">提交完整 SKILL.md 后只会生成待审核 patch，不会直接覆盖当前 Skill。</div>
                <textarea
                  className="skill-detail-body"
                  data-testid="learned-skill-feedback-body"
                  value={feedback.proposedSkillMd}
                  onChange={(event) => setFeedback((value) => value ? { ...value, proposedSkillMd: event.target.value } : value)}
                />
              </>
            )}
            <div className="confirm-actions">
              <span className="ad-spacer" />
              <button className="set-btn ghost soft" onClick={() => setFeedback(null)}>取消</button>
              <button
                className="set-btn primary"
                data-testid="learned-skill-feedback-submit"
                onClick={() => void submitFeedback()}
                disabled={feedbackBusy || !feedback.summary.trim() || (feedback.outcome === "correction" && !feedback.proposedSkillMd.trim())}
              >
                {feedback.outcome === "correction" ? "生成待审核 patch" : "记录反馈"}
              </button>
            </div>
          </div>
        </div>
      )}
      {snapshots && (
        <div className="confirm-mask" onClick={() => setSnapshots(null)}>
          <div className="confirm-box wide skill-snapshot-dialog" data-testid="learned-skill-snapshots" onClick={(event) => event.stopPropagation()}>
            <div className="confirm-title">版本快照 · {snapshots.learned.name}</div>
            {snapshots.items.length === 0 ? (
              <div className="inline-empty-state">还没有可回滚快照。维护、归档或回滚前会自动创建快照。</div>
            ) : (
              <div className="skill-snapshot-layout">
                <div className="skill-snapshot-list">
                  {snapshots.items.map((snapshot) => (
                    <button
                      key={snapshot.id}
                      className={snapshot.id === snapshots.selectedId ? "on" : ""}
                      onClick={() => setSnapshots((value) => value ? { ...value, selectedId: snapshot.id } : value)}
                    >
                      <strong>{snapshot.reason}</strong>
                      <span>{new Date(snapshot.createdAt).toLocaleString()}</span>
                    </button>
                  ))}
                </div>
                <pre className="skill-detail-body">{snapshots.items.find((item) => item.id === snapshots.selectedId)?.packageFiles["SKILL.md"] ?? ""}</pre>
              </div>
            )}
            <div className="confirm-actions">
              <span className="ad-spacer" />
              <button className="set-btn ghost soft" data-testid="learned-skill-snapshots-close" onClick={() => setSnapshots(null)}>关闭</button>
              <button className="set-btn primary" onClick={() => void rollbackSnapshot()} disabled={snapshotsBusy || !snapshots.selectedId}>回滚到此版本</button>
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
                              <button className="set-btn ghost soft" data-testid={`learned-skill-feedback-${learnedSkill.id}`} onClick={() => void openFeedback(learnedSkill, s)}>反馈</button>
                              <button className="set-btn ghost soft" data-testid={`learned-skill-versions-${learnedSkill.id}`} onClick={() => void openSnapshots(learnedSkill)} disabled={snapshotsBusy}>版本</button>
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
