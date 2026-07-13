import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SkillManager } from "@ew/skills";
import type { SkillCandidate, SkillCandidateCreate } from "@ew/shared";
import { SkillCandidateStore } from "../src/skill-learning/candidate-store.js";
import { SkillLearningCoordinator, type RestrictedSkillReviewInput } from "../src/skill-learning/coordinator.js";
import type { SkillCandidateService } from "../src/skill-learning/candidate-service.js";
import { SkillCandidateService as CandidateService } from "../src/skill-learning/candidate-service.js";
import { SqliteConversationRepo } from "../src/store/conversation.js";
import type { SessionHost } from "../src/agent/session-host.js";

let store: SkillCandidateStore | undefined;
let dir: string | undefined;
afterEach(() => {
  store?.close();
  store = undefined;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
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

describe("restricted background Skill learning", () => {
  it("treats cancelled, failed, and low-signal trajectories as successful skips", async () => {
    store = new SkillCandidateStore(":memory:");
    let calls = 0;
    const coordinator = new SkillLearningCoordinator({
      store,
      skills: new SkillManager([]),
      candidates: { stage: () => { throw new Error("must not stage"); } } as unknown as SkillCandidateService,
      reviewer: async () => { calls++; return proposal(); },
    });
    const base = {
      threadId: "t1",
      memoryScope: "global",
      model: "m",
      userText: "do work",
      finalText: "done",
      toolCalls: [{ name: "bash", ok: true }],
    };
    expect((await coordinator.review({ ...base, cancelled: true })).lastResult).toBe("skipped");
    expect((await coordinator.review({ ...base, toolCalls: [{ name: "bash", ok: false }] })).lastResult).toBe("skipped");
    expect((await coordinator.review(base)).lastResult).toBe("skipped");
    expect((await coordinator.review({ ...base, userText: "token=super-secret-value", toolCalls: new Array(4).fill({ name: "bash", ok: true }) })).lastResult).toBe("skipped");
    expect(calls).toBe(0);
  });

  it("passes only a read-only trajectory and catalog to the reviewer, and accepts Nothing to learn", async () => {
    store = new SkillCandidateStore(":memory:");
    let seen: RestrictedSkillReviewInput | undefined;
    const coordinator = new SkillLearningCoordinator({
      store,
      skills: new SkillManager([]),
      candidates: {} as SkillCandidateService,
      reviewer: async (input) => { seen = input; return null; },
    });
    const result = await coordinator.review({
      threadId: "t1",
      memoryScope: "global",
      model: "m",
      userText: "release",
      finalText: "released",
      toolCalls: new Array(4).fill(0).map((_, index) => ({ name: `tool-${index}`, ok: true })),
    });
    expect(result.lastResult).toBe("nothing");
    expect(Object.keys(seen ?? {}).sort()).toEqual(["catalog", "trajectory"]);
    expect(Object.isFrozen(seen?.trajectory)).toBe(true);
  });

  it("stages a candidate but never activates it", async () => {
    store = new SkillCandidateStore(":memory:");
    const staged: SkillCandidateCreate[] = [];
    const candidates = {
      stage(input: SkillCandidateCreate) {
        staged.push(input);
        const now = new Date().toISOString();
        return { ...input, id: "candidate", slug: input.name, status: "pending", validation: { valid: true, contentHash: "hash", findings: [], checkedAt: now }, createdAt: now, updatedAt: now } as SkillCandidate;
      },
    } as SkillCandidateService;
    const coordinator = new SkillLearningCoordinator({
      store,
      skills: new SkillManager([]),
      candidates,
      reviewer: async () => proposal(),
    });
    const result = await coordinator.review({
      threadId: "source-thread",
      memoryScope: "global",
      model: "m",
      userText: "release",
      finalText: "released",
      toolCalls: new Array(4).fill(0).map((_, index) => ({ name: `tool-${index}`, ok: true })),
    });
    expect(result).toMatchObject({ lastResult: "candidate", lastCandidateId: "candidate" });
    expect(staged[0]).toMatchObject({ createdBy: "background-learning", sourceThreadIds: ["source-thread"] });
  });

  it("derives background scope and provenance from the trusted trajectory instead of model output", async () => {
    store = new SkillCandidateStore(":memory:");
    const staged: SkillCandidateCreate[] = [];
    const candidates = {
      stage(input: SkillCandidateCreate) {
        staged.push(input);
        const now = new Date().toISOString();
        return { ...input, id: "candidate", slug: input.name, status: "pending", validation: { valid: true, contentHash: "hash", findings: [], checkedAt: now }, createdAt: now, updatedAt: now } as SkillCandidate;
      },
    } as SkillCandidateService;
    const coordinator = new SkillLearningCoordinator({
      store, skills: new SkillManager([]), candidates,
      reviewer: async () => ({ ...proposal(), scope: "global", workspaceId: undefined, sourceThreadIds: ["forged"], evidence: [{ sourceThreadId: "forged", summary: "claimed" }] }),
    });
    await coordinator.review({
      threadId: "trusted-source", memoryScope: "ws:project-1", model: "m", userText: "correct this",
      finalText: "done", toolCalls: [], corrected: true,
    });
    expect(staged[0]).toMatchObject({
      scope: "workspace", workspaceId: "project-1", sourceThreadIds: ["trusted-source"],
      evidence: [{ sourceThreadId: "trusted-source", summary: "claimed" }],
    });
  });
});

describe("learned Skill curator", () => {
  it("uses deterministic stale/archive transitions and supports snapshot rollback", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ew-skill-curator-"));
    const skillsDir = path.join(dir, "skills");
    store = new SkillCandidateStore(":memory:");
    const repo = new SqliteConversationRepo(":memory:");
    const skills = new SkillManager([skillsDir]);
    const service = new CandidateService({
      store, repo, skills, skillsDir, archiveDir: path.join(dir, "archive"),
      sessionHost: { invalidateAll() {} } as SessionHost,
      knownTools: () => [],
    });
    const approved = await service.approve(service.stage(proposal()).id);
    const learned = service.listLearned()[0]!;
    const original = fs.readFileSync(path.join(learned.path, "SKILL.md"), "utf8");
    const old = "2025-01-01T00:00:00.000Z";
    store.putLearned({ ...learned, createdAt: old, updatedAt: old });

    const first = service.curate(new Date("2025-02-01T00:00:00.000Z"));
    expect(first).toMatchObject({ stale: [learned.id], archived: [], messages: [expect.stringContaining("active → stale")] });
    const stale = store.getLearned(learned.id)!;
    expect(stale.state).toBe("stale");
    store.putLearned({ ...stale, updatedAt: old });
    const second = service.curate(new Date("2025-02-01T00:00:00.000Z"));
    expect(second).toMatchObject({ stale: [], archived: [learned.id], messages: [expect.stringContaining("stale → archived")] });
    expect(store.getLearned(learned.id)?.state).toBe("archived");

    service.restoreLearned(learned.id);
    const snapshot = service.snapshotLearned(learned.id, "before test mutation");
    fs.writeFileSync(path.join(learned.path, "SKILL.md"), "changed", "utf8");
    service.rollbackLearned(learned.id, snapshot.id);
    expect(fs.readFileSync(path.join(learned.path, "SKILL.md"), "utf8")).toBe(original);
    expect(service.listSnapshots(learned.id).length).toBeGreaterThanOrEqual(3);
    expect(approved.status).toBe("approved");
    repo.close();
  });

  it("runs opt-in consolidation as a version-locked pending patch with used Skill body context", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ew-skill-consolidate-"));
    const skillsDir = path.join(dir, "skills");
    store = new SkillCandidateStore(":memory:");
    const repo = new SqliteConversationRepo(":memory:");
    const skills = new SkillManager([skillsDir]);
    const service = new CandidateService({
      store, repo, skills, skillsDir, archiveDir: path.join(dir, "archive"),
      sessionHost: { invalidateAll() {} } as SessionHost, knownTools: () => [],
    });
    const seeded = proposal();
    seeded.proposedSkillMd = seeded.proposedSkillMd.replace("1. Test.", "1. Test with [the checklist](references/check.md).");
    seeded.packageFiles = { "references/check.md": "# Checklist\n" };
    await service.approve(service.stage(seeded).id);
    let sawBody = false;
    let sawSupport = false;
    const coordinator = new SkillLearningCoordinator({
      store, candidates: service, skills,
      reviewer: async ({ catalog }) => {
        const base = catalog.find((item) => item.baseSkillId)!;
        sawBody = !!base.skillMd?.includes("## Procedure");
        sawSupport = base.packageFiles?.["references/check.md"] === "# Checklist\n";
        return {
          ...proposal(),
          proposedSkillMd: proposal().proposedSkillMd.replace("1. Test.", "1. Test twice."),
          baseSkillId: base.baseSkillId,
          baseContentHash: base.baseContentHash,
        };
      },
    });
    coordinator.updateSettings({ consolidationEnabled: true, learnerModel: "m" });
    const status = await coordinator.consolidate();
    expect(status.lastResult).toBe("candidate");
    expect(sawBody).toBe(true);
    expect(sawSupport).toBe(true);
    expect(service.list().filter((candidate) => candidate.status === "pending")).toEqual([
      expect.objectContaining({ baseSkillId: service.listLearned()[0]!.id, sourceThreadIds: [] }),
    ]);
    expect(fs.readFileSync(path.join(service.listLearned()[0]!.path, "SKILL.md"), "utf8")).not.toContain("Test twice");
    repo.close();
  });
});
