import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SkillManager } from "@ew/skills";
import type { SkillCandidateCreate } from "@ew/shared";
import { SkillCandidateLifecycle } from "../src/skill-learning/candidate-service.js";
import { SqliteConversationRepo } from "../src/store/conversation.js";

let lifecycle: SkillCandidateLifecycle | undefined;
let repo: SqliteConversationRepo | undefined;
let tmpDir: string | undefined;

afterEach(async () => {
  await lifecycle?.close();
  lifecycle = undefined;
  repo?.close();
  repo = undefined;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = undefined;
});

function proposal(): SkillCandidateCreate {
  return {
    name: "tested-release",
    description: "Reuse a verified release procedure",
    triggerConditions: ["when releasing"],
    scope: "global",
    proposedSkillMd:
      "---\nname: tested-release\ndescription: Reuse a verified release procedure\nwhenToUse: when releasing\n---\n# Release\n## Procedure\n1. Test.\n## Pitfalls\n- Avoid secrets.\n## Verification\n- Check artifact.\n",
    requiredTools: [],
    sourceThreadIds: [],
    evidence: [],
    reason: "Verified reusable trajectory",
    createdBy: "background-learning",
  };
}

describe("SkillCandidateLifecycle", () => {
  it("keeps a reviewed Candidate pending until approval activates a Learned Skill", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ew-skill-lifecycle-"));
    const skillsDir = path.join(tmpDir, "skills");
    const skills = new SkillManager([skillsDir]);
    repo = new SqliteConversationRepo(":memory:");
    lifecycle = new SkillCandidateLifecycle({
      dbPath: ":memory:",
      skills,
      skillsDir,
      repo,
      archiveDir: path.join(tmpDir, "archive"),
      sessionInvalidator: { invalidateAll() {} },
      knownTools: () => [],
      reviewer: async () => proposal(),
    });

    const review = await lifecycle.review({
      threadId: "source-thread",
      memoryScope: "global",
      model: "review-model",
      userText: "release the build",
      finalText: "released after tests passed",
      toolCalls: new Array(4).fill(0).map((_, index) => ({ name: `tool-${index}`, ok: true })),
    });

    expect(review).toMatchObject({ lastResult: "candidate" });
    const candidate = lifecycle.list().find((item) => item.id === review.lastCandidateId)!;
    expect(candidate).toMatchObject({
      status: "pending",
      createdBy: "background-learning",
      sourceThreadIds: ["source-thread"],
    });
    expect(lifecycle.listLearned()).toEqual([]);
    expect(fs.existsSync(path.join(skillsDir, "tested-release"))).toBe(false);

    const approved = await lifecycle.approve(candidate.id);

    expect(approved.status).toBe("approved");
    expect(lifecycle.listLearned()).toEqual([
      expect.objectContaining({ slug: "tested-release", state: "active", sourceCandidateId: candidate.id }),
    ]);
    expect(fs.readFileSync(path.join(skillsDir, "tested-release", "SKILL.md"), "utf8")).toContain(
      "## Verification",
    );
  });

  it("waits for scheduled reviews before closing its local store", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ew-skill-lifecycle-close-"));
    let releaseReview!: () => void;
    let markStarted!: () => void;
    let reviewerFinished = false;
    const reviewStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const reviewGate = new Promise<void>((resolve) => { releaseReview = resolve; });
    repo = new SqliteConversationRepo(":memory:");
    lifecycle = new SkillCandidateLifecycle({
      dbPath: ":memory:",
      skills: new SkillManager([path.join(tmpDir, "skills")]),
      skillsDir: path.join(tmpDir, "skills"),
      repo,
      archiveDir: path.join(tmpDir, "archive"),
      sessionInvalidator: { invalidateAll() {} },
      reviewer: async () => {
        markStarted();
        await reviewGate;
        reviewerFinished = true;
        return proposal();
      },
    });
    lifecycle.schedule({
      threadId: "source-thread",
      memoryScope: "global",
      model: "review-model",
      userText: "release the build",
      finalText: "released after tests passed",
      toolCalls: new Array(4).fill(0).map((_, index) => ({ name: `tool-${index}`, ok: true })),
    });
    await reviewStarted;

    let closed = false;
    const closing = Promise.resolve(lifecycle.close()).then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);

    releaseReview();
    await closing;
    expect(reviewerFinished).toBe(true);
  });
});
