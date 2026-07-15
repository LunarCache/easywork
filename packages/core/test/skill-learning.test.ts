import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SkillManager } from "@ew/skills";
import type { SkillCandidateCreate } from "@ew/shared";
import { SkillCandidateLifecycle } from "../src/skill-learning/candidate-service.js";
import type { RestrictedSkillReviewInput, RestrictedSkillReviewer } from "../src/skill-learning/coordinator.js";
import { SqliteConversationRepo } from "../src/store/conversation.js";

const lifecycles: SkillCandidateLifecycle[] = [];
const repos: SqliteConversationRepo[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(lifecycles.splice(0).map((lifecycle) => lifecycle.close()));
  for (const repo of repos.splice(0)) repo.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function proposal(): SkillCandidateCreate {
  return {
    name: "tested-release",
    description: "Reuse a verified release procedure",
    triggerConditions: ["when releasing"],
    scope: "global",
    proposedSkillMd: "---\nname: tested-release\ndescription: Reuse a verified release procedure\nwhenToUse: when releasing\n---\n# Release\n## Procedure\n1. Test.\n## Pitfalls\n- Avoid secrets.\n## Verification\n- Check artifact.\n",
    requiredTools: [],
    sourceThreadIds: [],
    evidence: [],
    reason: "Verified reusable trajectory",
    createdBy: "background-learning",
  };
}

function createLifecycle(reviewer: RestrictedSkillReviewer = async () => null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ew-skill-learning-"));
  const repo = new SqliteConversationRepo(":memory:");
  const skillsDir = path.join(dir, "skills");
  const skills = new SkillManager([skillsDir]);
  const lifecycle = new SkillCandidateLifecycle({
    dbPath: ":memory:",
    repo,
    skills,
    skillsDir,
    archiveDir: path.join(dir, "archive"),
    sessionInvalidator: { invalidateAll() {} },
    knownTools: () => [],
    reviewer,
  });
  lifecycles.push(lifecycle);
  repos.push(repo);
  dirs.push(dir);
  return { lifecycle, skills, skillsDir };
}

const baseTrajectory = {
  threadId: "t1",
  memoryScope: "global",
  model: "m",
  userText: "do work",
  finalText: "done",
  toolCalls: [{ name: "bash", ok: true }],
};

describe("restricted background Skill learning", () => {
  it("treats cancelled, failed, secret-bearing, and low-signal trajectories as skips", async () => {
    let calls = 0;
    const { lifecycle } = createLifecycle(async () => { calls++; return proposal(); });

    expect((await lifecycle.review({ ...baseTrajectory, cancelled: true })).lastResult).toBe("skipped");
    expect((await lifecycle.review({ ...baseTrajectory, toolCalls: [{ name: "bash", ok: false }] })).lastResult).toBe("skipped");
    expect((await lifecycle.review(baseTrajectory)).lastResult).toBe("skipped");
    expect((await lifecycle.review({
      ...baseTrajectory,
      userText: "token=super-secret-value",
      toolCalls: new Array(4).fill({ name: "bash", ok: true }),
    })).lastResult).toBe("skipped");
    expect(calls).toBe(0);
  });

  it("passes a frozen restricted input and lifecycle-selected model to the reviewer", async () => {
    let seen: RestrictedSkillReviewInput | undefined;
    let seenModel: string | undefined;
    const { lifecycle } = createLifecycle(async (input, model) => {
      seen = input;
      seenModel = model;
      return null;
    });
    lifecycle.updateSettings({ learnerModel: "configured-reviewer" });
    const result = await lifecycle.review({
      ...baseTrajectory,
      userText: "release",
      finalText: "released",
      toolCalls: new Array(4).fill(0).map((_, index) => ({ name: `tool-${index}`, ok: true })),
    });

    expect(result.lastResult).toBe("nothing");
    expect(Object.keys(seen ?? {}).sort()).toEqual(["catalog", "trajectory"]);
    expect(Object.isFrozen(seen?.trajectory)).toBe(true);
    expect(seenModel).toBe("configured-reviewer");
  });

  it("derives pending Candidate scope and provenance from the trusted trajectory", async () => {
    const { lifecycle } = createLifecycle(async () => ({
      ...proposal(),
      scope: "global",
      workspaceId: undefined,
      sourceThreadIds: ["forged"],
      evidence: [{ sourceThreadId: "forged", summary: "claimed" }],
    }));

    const repo = repos[repos.length - 1]!;
    const project = repo.createProject({ name: "Trusted project", workspaceDir: dirs[dirs.length - 1]! });
    const result = await lifecycle.review({
      threadId: "trusted-source",
      memoryScope: `ws:${project.id}`,
      model: "m",
      userText: "correct this",
      finalText: "done",
      toolCalls: [],
      corrected: true,
    });

    expect(lifecycle.get(result.lastCandidateId!)).toMatchObject({
      status: "pending",
      createdBy: "background-learning",
      scope: "workspace",
      workspaceId: project.id,
      sourceThreadIds: ["trusted-source"],
      evidence: [{ sourceThreadId: "trusted-source", summary: "claimed" }],
    });
    expect(lifecycle.listLearned()).toEqual([]);
  });
});

describe("learned Skill lifecycle", () => {
  it("owns telemetry, pin, curation, archive, restore, snapshot, and rollback", async () => {
    const { lifecycle } = createLifecycle();
    await lifecycle.approve(lifecycle.stage(proposal()).id);
    const learned = lifecycle.listLearned()[0]!;
    const original = fs.readFileSync(path.join(learned.path, "SKILL.md"), "utf8");

    expect(lifecycle.recordTelemetry(learned.id, "success").successes).toBe(1);
    expect(lifecycle.pinLearned(learned.id, true).pinned).toBe(true);
    expect(lifecycle.curate(new Date("2100-01-01T00:00:00.000Z")).stale).toEqual([]);
    lifecycle.pinLearned(learned.id, false);
    expect(lifecycle.curate(new Date("2100-01-01T00:00:00.000Z")).stale).toEqual([learned.id]);
    expect(lifecycle.curate(new Date("2100-02-01T00:00:00.000Z")).archived).toEqual([learned.id]);

    lifecycle.restoreLearned(learned.id);
    const snapshot = lifecycle.snapshotLearned(learned.id, "before test mutation");
    fs.writeFileSync(path.join(learned.path, "SKILL.md"), "changed", "utf8");
    lifecycle.rollbackLearned(learned.id, snapshot.id);
    expect(fs.readFileSync(path.join(learned.path, "SKILL.md"), "utf8")).toBe(original);
    expect(lifecycle.listSnapshots(learned.id).length).toBeGreaterThanOrEqual(3);
  });

  it("runs consolidation as a version-locked pending patch without mutating the active package", async () => {
    let sawBody = false;
    let sawSupport = false;
    const { lifecycle } = createLifecycle(async ({ catalog }) => {
      const base = catalog.find((item) => item.baseSkillId)!;
      sawBody = !!base.skillMd?.includes("## Procedure");
      sawSupport = base.packageFiles?.["references/check.md"] === "# Checklist\n";
      return {
        ...proposal(),
        proposedSkillMd: proposal().proposedSkillMd.replace("1. Test.", "1. Test twice."),
        baseSkillId: base.baseSkillId,
        baseContentHash: base.baseContentHash,
      };
    });
    const seeded = proposal();
    seeded.proposedSkillMd = seeded.proposedSkillMd.replace("1. Test.", "1. Test with [the checklist](references/check.md).");
    seeded.packageFiles = { "references/check.md": "# Checklist\n" };
    await lifecycle.approve(lifecycle.stage(seeded).id);
    lifecycle.updateSettings({ consolidationEnabled: true, learnerModel: "m" });

    const status = await lifecycle.consolidate();
    expect(status.lastResult).toBe("candidate");
    expect(sawBody).toBe(true);
    expect(sawSupport).toBe(true);
    expect(lifecycle.list().filter((candidate) => candidate.status === "pending")).toEqual([
      expect.objectContaining({ baseSkillId: lifecycle.listLearned()[0]!.id, sourceThreadIds: [] }),
    ]);
    expect(fs.readFileSync(path.join(lifecycle.listLearned()[0]!.path, "SKILL.md"), "utf8")).not.toContain("Test twice");
  });
});
