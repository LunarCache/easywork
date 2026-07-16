import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { workspaceScope } from "@ew/shared";
import { chatWorkspaceDir } from "../src/config/paths.js";
import { createCore, type CoreServer } from "../src/server/app.js";

let core: CoreServer | undefined;
let tmpDir: string | undefined;
let scratchDir: string | undefined;

afterEach(async () => {
  await core?.stop();
  core = undefined;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  if (scratchDir) fs.rmSync(scratchDir, { recursive: true, force: true });
  tmpDir = undefined;
  scratchDir = undefined;
});

function makeCore(): CoreServer {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ew-source-conversation-"));
  return createCore({
    token: "test",
    dbPath: ":memory:",
    memoryDbPath: ":memory:",
    memoryDir: path.join(tmpDir, "memory"),
    skillLearningDbPath: ":memory:",
    agentDir: path.join(tmpDir, "pi-agent"),
  });
}

function runClaimInput(threadId: string) {
  return {
    threadId,
    modelId: "test-model",
    title: "会话",
    runWorkspaceDir: chatWorkspaceDir(threadId),
  };
}

describe("SourceConversationLifecycle", () => {
  it("deletes source-owned conversation state while preserving independent facts", async () => {
    core = makeCore();
    const thread = core.repo.createThread({ title: "来源对话", modelId: "test-model" });
    core.repo.appendMessage({
      id: "source-message",
      threadId: thread.id,
      role: "user",
      seq: core.repo.nextSeq(thread.id),
      parts: [{ type: "text", text: "只属于这个来源的内容" }],
      createdAt: new Date().toISOString(),
    });
    const derived = await core.memory.write({
      layer: "agent-notes",
      text: "由来源对话抽取",
      origin: "extracted",
      state: "derived",
      sourceThreadId: thread.id,
    });
    const curated = await core.memory.write({
      layer: "agent-notes",
      text: "独立保留",
      origin: "agent-managed",
      state: "curated",
    });
    const staged = await core.app.inject({
      method: "POST",
      url: "/skill-candidates",
      headers: { authorization: "Bearer test" },
      payload: {
        name: "source-owned-flow",
        description: "A source-owned flow",
        triggerConditions: ["run source-owned flow"],
        scope: "global",
        proposedSkillMd: "---\nname: source-owned-flow\ndescription: A source-owned flow\nwhenToUse: run source-owned flow\n---\n## Procedure\n1. Run.\n## Verification\n- Verify.\n",
        requiredTools: [],
        sourceThreadIds: [thread.id],
        evidence: [{ sourceThreadId: thread.id, summary: "worked" }],
        reason: "Reusable",
        createdBy: "background-learning",
      },
    });
    expect(staged.statusCode).toBe(200);
    const sessionFile = path.join(tmpDir!, "pi-agent", "sessions", `${thread.id}.jsonl`);
    fs.writeFileSync(sessionFile, '{"type":"session"}\n', "utf8");
    scratchDir = chatWorkspaceDir(thread.id);
    fs.mkdirSync(scratchDir, { recursive: true });
    fs.writeFileSync(path.join(scratchDir, "report.html"), "<h1>result</h1>", "utf8");

    const result = await core.sourceConversations.delete(thread.id);

    expect(result).toEqual({ factsRemoved: 1 });
    expect(core.repo.getThread(thread.id)).toBeNull();
    expect(core.repo.history(thread.id)).toEqual([]);
    expect(core.repo.searchMessages("来源")).toEqual([]);
    expect((await core.memory.list()).map((item) => item.id)).toEqual([curated.id]);
    expect((await core.memory.list()).map((item) => item.id)).not.toContain(derived.id);
    const candidates = await core.app.inject({
      method: "GET",
      url: "/skill-candidates",
      headers: { authorization: "Bearer test" },
    });
    expect(candidates.json<{ candidates: unknown[] }>().candidates).toEqual([]);
    expect(fs.existsSync(sessionFile)).toBe(false);
    expect(fs.existsSync(scratchDir)).toBe(false);
  });

  it("deletes every project Source Conversation without removing the user workspace", async () => {
    core = makeCore();
    const workspaceDir = path.join(tmpDir!, "user-workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    const userFile = path.join(workspaceDir, "keep.txt");
    fs.writeFileSync(userFile, "user-owned", "utf8");
    const project = core.repo.createProject({ name: "项目", workspaceDir });
    const first = core.repo.createThread({ title: "来源一", modelId: "m", projectId: project.id });
    const second = core.repo.createThread({ title: "来源二", modelId: "m", projectId: project.id });
    await core.memory.write({
      scope: workspaceScope(project.id),
      layer: "decisions",
      text: "来源一的派生事实",
      origin: "extracted",
      state: "derived",
      sourceThreadId: first.id,
    });
    await core.memory.write({
      scope: workspaceScope(project.id),
      layer: "conventions",
      text: "工作区独立约定",
    });
    const global = await core.memory.write({ layer: "agent-notes", text: "其他作用域事实" });
    const staged = await core.app.inject({
      method: "POST",
      url: "/skill-candidates",
      headers: { authorization: "Bearer test" },
      payload: {
        name: "workspace-owned-flow",
        description: "A workspace-owned flow",
        triggerConditions: ["work in this workspace"],
        scope: "workspace",
        workspaceId: project.id,
        proposedSkillMd: "---\nname: workspace-owned-flow\ndescription: A workspace-owned flow\nwhenToUse: work in this workspace\n---\n## Procedure\n1. Run.\n## Verification\n- Verify.\n",
        requiredTools: [],
        sourceThreadIds: [first.id],
        evidence: [{ sourceThreadId: first.id, summary: "worked" }],
        reason: "Reusable",
        createdBy: "background-learning",
      },
    });
    expect(staged.statusCode).toBe(200);

    await core.sourceConversations.deleteProject(project.id);

    expect(core.repo.getProject(project.id)).toBeNull();
    expect(core.repo.getThread(first.id)).toBeNull();
    expect(core.repo.getThread(second.id)).toBeNull();
    expect(await core.memory.list({ scope: workspaceScope(project.id) })).toEqual([]);
    expect((await core.memory.list()).map((item) => item.id)).toContain(global.id);
    const candidates = await core.app.inject({
      method: "GET",
      url: "/skill-candidates",
      headers: { authorization: "Bearer test" },
    });
    expect(candidates.json<{ candidates: unknown[] }>().candidates).toEqual([]);
    expect(fs.readFileSync(userFile, "utf8")).toBe("user-owned");
  });

  it("keeps ownership state when required cleanup fails", async () => {
    core = makeCore();
    const thread = core.repo.createThread({ title: "来源对话", modelId: "test-model" });
    const fact = await core.memory.write({
      layer: "agent-notes",
      text: "仍由来源拥有",
      origin: "extracted",
      state: "derived",
      sourceThreadId: thread.id,
    });
    core.memory.deleteBySession = async () => {
      throw new Error("memory db unavailable");
    };

    await expect(core.sourceConversations.delete(thread.id)).rejects.toThrow("memory db unavailable");

    expect(core.repo.getThread(thread.id)?.id).toBe(thread.id);
    expect((await core.memory.list()).map((item) => item.id)).toContain(fact.id);
  });

  it("does not fail ownership deletion when scratch artifact cleanup fails", async () => {
    core = makeCore();
    const thread = core.repo.createThread({ title: "来源对话", modelId: "test-model" });
    scratchDir = chatWorkspaceDir(thread.id);
    fs.mkdirSync(scratchDir, { recursive: true });
    fs.writeFileSync(path.join(scratchDir, "artifact.txt"), "derived", "utf8");
    const originalRmSync = fs.rmSync;
    const rm = vi.spyOn(fs, "rmSync").mockImplementation((target, options) => {
      if (path.resolve(String(target)) === path.resolve(scratchDir!)) throw new Error("scratch busy");
      return originalRmSync(target, options);
    });

    try {
      await expect(core.sourceConversations.delete(thread.id)).resolves.toEqual({ factsRemoved: 0 });
    } finally {
      rm.mockRestore();
    }

    expect(core.repo.getThread(thread.id)).toBeNull();
    expect(fs.existsSync(scratchDir)).toBe(true);
  });

  it("discards an uncommitted shell without tombstoning its thread id", async () => {
    core = makeCore();
    const thread = core.repo.createThread({ id: "retryable-empty", title: "空壳", modelId: "test-model" });
    const sessionFile = path.join(tmpDir!, "pi-agent", "sessions", `${thread.id}.jsonl`);
    fs.writeFileSync(sessionFile, '{"type":"session"}\n', "utf8");
    scratchDir = chatWorkspaceDir(thread.id);
    fs.mkdirSync(scratchDir, { recursive: true });
    fs.writeFileSync(path.join(scratchDir, "partial.txt"), "partial", "utf8");

    const claim = await core.sourceConversations.claimRun(runClaimInput(thread.id));
    expect(claim).not.toBeNull();
    await core.sourceConversations.discardEmpty(thread.id, claim!);

    expect(core.repo.getThread(thread.id)).toBeNull();
    expect(fs.existsSync(sessionFile)).toBe(false);
    expect(fs.existsSync(scratchDir)).toBe(false);
    const retry = await core.app.inject({
      method: "POST",
      url: "/agent/run",
      headers: { authorization: "Bearer test" },
      payload: { threadId: thread.id, model: "missing-model", history: [] },
    });
    expect(retry.statusCode).toBe(404);
    expect(retry.json()).toMatchObject({ error: "model_not_loaded" });
  });

  it("removes source-owned facts and candidates when discarding an uncommitted shell", async () => {
    core = makeCore();
    const thread = core.repo.createThread({ id: "staged-empty", title: "空壳", modelId: "test-model" });
    await core.memory.write({
      layer: "agent-notes",
      text: "首轮失败前暂存的派生事实",
      origin: "extracted",
      state: "derived",
      sourceThreadId: thread.id,
    });
    const staged = await core.app.inject({
      method: "POST",
      url: "/skill-candidates",
      headers: { authorization: "Bearer test" },
      payload: {
        name: "discarded-source-flow",
        description: "A flow staged before the source turn failed",
        triggerConditions: ["discarded source flow"],
        scope: "global",
        proposedSkillMd: "---\nname: discarded-source-flow\ndescription: A flow staged before the source turn failed\nwhenToUse: discarded source flow\n---\n## Procedure\n1. Run.\n## Verification\n- Verify.\n",
        requiredTools: [],
        sourceThreadIds: [thread.id],
        evidence: [{ sourceThreadId: thread.id, summary: "staged before failure" }],
        reason: "Potentially reusable",
        createdBy: "background-learning",
      },
    });
    expect(staged.statusCode).toBe(200);

    const claim = await core.sourceConversations.claimRun(runClaimInput(thread.id));
    expect(claim).not.toBeNull();
    await core.sourceConversations.discardEmpty(thread.id, claim!);

    expect(core.repo.getThread(thread.id)).toBeNull();
    expect(await core.memory.list()).toEqual([]);
    const candidates = await core.app.inject({
      method: "GET",
      url: "/skill-candidates",
      headers: { authorization: "Bearer test" },
    });
    expect(candidates.json<{ candidates: unknown[] }>().candidates).toEqual([]);
  });

  it("does not discard a claimed shell after a message has been committed", async () => {
    core = makeCore();
    const thread = core.repo.createThread({ id: "committed-shell", title: "会话", modelId: "test-model" });
    const claim = await core.sourceConversations.claimRun(runClaimInput(thread.id));
    expect(claim).not.toBeNull();
    core.repo.appendMessage({
      id: "committed-message",
      threadId: thread.id,
      role: "user",
      seq: core.repo.nextSeq(thread.id),
      parts: [{ type: "text", text: "已经提交" }],
      createdAt: new Date().toISOString(),
    });

    await core.sourceConversations.discardEmpty(thread.id, claim!);

    expect(core.repo.getThread(thread.id)?.id).toBe(thread.id);
    expect(core.repo.history(thread.id)).toHaveLength(1);
  });

  it("atomically orders shell creation against permanent deletion", async () => {
    core = makeCore();
    const deleteFirstId = "delete-before-claim";
    const deleteFirst = core.sourceConversations.delete(deleteFirstId);
    const rejectedClaim = await core.sourceConversations.claimRun(runClaimInput(deleteFirstId));
    await deleteFirst;

    expect(rejectedClaim).toBeNull();
    expect(core.repo.getThread(deleteFirstId)).toBeNull();
    expect(fs.existsSync(chatWorkspaceDir(deleteFirstId))).toBe(false);

    const claimFirstId = "claim-before-delete";
    const acceptedClaim = await core.sourceConversations.claimRun(runClaimInput(claimFirstId));
    expect(acceptedClaim).toMatchObject({ created: true });
    expect(core.repo.getThread(claimFirstId)?.id).toBe(claimFirstId);

    await core.sourceConversations.delete(claimFirstId);

    expect(core.repo.getThread(claimFirstId)).toBeNull();
    expect(fs.existsSync(chatWorkspaceDir(claimFirstId))).toBe(false);
  });

  it("rejects new project conversation claims after project deletion starts", async () => {
    core = makeCore();
    const workspaceDir = path.join(tmpDir!, "project-delete-race");
    fs.mkdirSync(workspaceDir, { recursive: true });
    const marker = path.join(workspaceDir, "keep.txt");
    fs.writeFileSync(marker, "user-owned", "utf8");
    const project = core.repo.createProject({ name: "删除中的项目", workspaceDir });
    const originalDeleteByScope = core.memory.deleteByScope.bind(core.memory);
    let scopeDeletionStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      scopeDeletionStarted = resolve;
    });
    let releaseScopeDeletion!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseScopeDeletion = resolve;
    });
    core.memory.deleteByScope = async (scope) => {
      scopeDeletionStarted();
      await gate;
      return originalDeleteByScope(scope);
    };

    const deletion = core.sourceConversations.deleteProject(project.id);
    await started;
    const lateClaim = await core.sourceConversations.claimRun({
      threadId: "late-project-thread",
      modelId: "test-model",
      title: "迟到会话",
      projectId: project.id,
      runWorkspaceDir: workspaceDir,
    });
    releaseScopeDeletion();
    await deletion;

    expect(lateClaim).toBeNull();
    expect(core.repo.getThread("late-project-thread")).toBeNull();
    expect(core.repo.getProject(project.id)).toBeNull();
    expect(fs.readFileSync(marker, "utf8")).toBe("user-owned");
  });

  it("lets channel deletion win over concurrent claims and permits a later new Source Conversation", async () => {
    core = makeCore();
    const original = core.repo.resolveThreadForChannel("wechat", "wxid-delete-race", { modelId: "test-model" });
    const originalDeleteBySession = core.memory.deleteBySession.bind(core.memory);
    let deletionStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      deletionStarted = resolve;
    });
    let releaseDeletion!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseDeletion = resolve;
    });
    core.memory.deleteBySession = async (threadId) => {
      if (threadId === original.id) {
        deletionStarted();
        await gate;
      }
      return originalDeleteBySession(threadId);
    };

    const deletion = core.sourceConversations.delete(original.id);
    await started;
    const acceptDuringDeletion = vi.fn();
    const concurrent = await core.sourceConversations.claimChannelRun({
      kind: "wechat",
      channelUserId: "wxid-delete-race",
      defaultModelId: "test-model",
    }, acceptDuringDeletion);

    expect(concurrent).toBeNull();
    expect(acceptDuringDeletion).not.toHaveBeenCalled();
    releaseDeletion();
    await deletion;

    const acceptLater = vi.fn();
    const later = await core.sourceConversations.claimChannelRun({
      kind: "wechat",
      channelUserId: "wxid-delete-race",
      defaultModelId: "test-model",
    }, acceptLater);

    expect(later).not.toBeNull();
    expect(later!.thread.id).not.toBe(original.id);
    expect(acceptLater).toHaveBeenCalledOnce();
  });
});
