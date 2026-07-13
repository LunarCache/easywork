import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { workspaceScope } from "@ew/shared";
import { createCore, type CoreServer } from "../src/server/app.js";

let core: CoreServer | undefined;
let tmpDir: string | undefined;

afterEach(async () => {
  await core?.stop();
  core = undefined;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = undefined;
});

function makeCore(): CoreServer {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ew-routes-"));
  return createCore({
    token: "t",
    dbPath: ":memory:",
    memoryDbPath: ":memory:",
    memoryDir: path.join(tmpDir, "memory"),
    kbDbPath: ":memory:",
    agentDir: path.join(tmpDir, "pi-agent"),
  });
}

describe("server route modules", () => {
  it("manages MCP server configs through HTTP routes", async () => {
    core = makeCore();
    const config = {
      id: "docs",
      displayName: "Docs",
      transport: { kind: "http" as const, url: "https://mcp.example.test" },
      enabled: true,
    };

    const add = await core.app.inject({
      method: "POST",
      url: "/mcp/servers",
      headers: { authorization: "Bearer t" },
      payload: config,
    });
    expect(add.statusCode).toBe(200);

    const list = await core.app.inject({
      method: "GET",
      url: "/mcp/servers",
      headers: { authorization: "Bearer t" },
    });
    expect(list.json()).toEqual({ servers: [config] });

    const remove = await core.app.inject({
      method: "DELETE",
      url: "/mcp/servers/docs",
      headers: { authorization: "Bearer t" },
    });
    expect(remove.statusCode).toBe(200);
    expect(core.mcp.list()).toEqual([]);
  });

  it("manages memory and protects global scope clearing through HTTP routes", async () => {
    core = makeCore();
    const write = await core.app.inject({
      method: "POST",
      url: "/memory",
      headers: { authorization: "Bearer t" },
      payload: { layer: "user-profile", text: "用户偏好简洁回答" },
    });
    expect(write.statusCode).toBe(200);

    const list = await core.app.inject({
      method: "GET",
      url: "/memory?layer=user-profile",
      headers: { authorization: "Bearer t" },
    });
    expect(list.json<{ items: { text: string; origin: string; state: string }[] }>().items).toEqual(
      [expect.objectContaining({ text: "用户偏好简洁回答", origin: "manual", state: "curated" })],
    );

    const badLayer = await core.app.inject({
      method: "GET",
      url: "/memory?layer=not-a-layer",
      headers: { authorization: "Bearer t" },
    });
    expect(badLayer.statusCode).toBe(400);

    const globalClear = await core.app.inject({
      method: "DELETE",
      url: "/memory/scope/global",
      headers: { authorization: "Bearer t" },
    });
    expect(globalClear.statusCode).toBe(400);
  });

  it("allows clearing workspace-scoped memory through HTTP routes", async () => {
    core = makeCore();
    const scope = workspaceScope("proj1");
    await core.memory.write({ scope, layer: "pitfalls", text: "测试作用域隔离" });

    const clear = await core.app.inject({
      method: "DELETE",
      url: `/memory/scope/${encodeURIComponent(scope)}`,
      headers: { authorization: "Bearer t" },
    });

    expect(clear.statusCode).toBe(200);
    expect(clear.json()).toEqual({ removed: 1 });
    expect(await core.memory.list({ scope })).toEqual([]);
  });

  it("promotes an Extracted Fact and preserves it when its Source Conversation is deleted", async () => {
    core = makeCore();
    const thread = core.repo.createThread({ title: "来源对话", modelId: "test-model" });
    const extracted = await core.memory.write({
      layer: "user-profile",
      text: "用户偏好先给结论",
      origin: "extracted",
      state: "derived",
      sourceThreadId: thread.id,
    });

    const promote = await core.app.inject({
      method: "POST",
      url: `/memory/${encodeURIComponent(extracted.id)}/promote`,
      headers: { authorization: "Bearer t" },
    });
    expect(promote.statusCode).toBe(200);
    expect(promote.json()).toMatchObject({
      id: extracted.id,
      origin: "extracted",
      state: "curated",
      meta: { promotedBy: "user", promotedFromSourceThreadId: thread.id },
    });
    expect(promote.json<{ sourceThreadId?: string }>().sourceThreadId).toBeUndefined();

    const removeThread = await core.app.inject({
      method: "DELETE",
      url: `/threads/${encodeURIComponent(thread.id)}`,
      headers: { authorization: "Bearer t" },
    });
    expect(removeThread.statusCode).toBe(200);
    expect(removeThread.json()).toMatchObject({ ok: true, factsRemoved: 0 });
    expect((await core.memory.list()).map((item) => item.id)).toContain(extracted.id);
  });

  it("pinning an Extracted Fact promotes it", async () => {
    core = makeCore();
    const extracted = await core.memory.write({
      layer: "user-profile",
      text: "用户偏好先给结论",
      origin: "extracted",
      state: "derived",
      sourceThreadId: "source-thread",
    });

    const pin = await core.app.inject({
      method: "POST",
      url: `/memory/${encodeURIComponent(extracted.id)}/pin`,
      headers: { authorization: "Bearer t" },
    });

    expect(pin.statusCode).toBe(200);
    expect(pin.json()).toMatchObject({
      id: extracted.id,
      state: "curated",
      meta: { promotedBy: "user" },
    });
    expect(await core.memory.deleteBySession("source-thread")).toBe(0);
  });

  it("deleting a Source Conversation removes only its unpromoted Extracted Facts", async () => {
    core = makeCore();
    const thread = core.repo.createThread({ title: "来源对话", modelId: "test-model" });
    const extracted = await core.memory.write({
      layer: "agent-memory",
      text: "这条事实仍依赖来源",
      origin: "extracted",
      state: "derived",
      sourceThreadId: thread.id,
    });
    const curated = await core.memory.write({
      layer: "agent-memory",
      text: "这条事实独立保留",
      origin: "agent-managed",
      state: "curated",
    });

    const removeThread = await core.app.inject({
      method: "DELETE",
      url: `/threads/${encodeURIComponent(thread.id)}`,
      headers: { authorization: "Bearer t" },
    });
    expect(removeThread.json()).toMatchObject({ ok: true, factsRemoved: 1 });
    expect((await core.memory.list()).map((item) => item.id)).toEqual([curated.id]);
    expect((await core.memory.list()).map((item) => item.id)).not.toContain(extracted.id);
  });

  it("keeps the Source Conversation when deleting its Extracted Facts fails", async () => {
    core = makeCore();
    const thread = core.repo.createThread({ title: "来源对话", modelId: "test-model" });
    const extracted = await core.memory.write({
      layer: "agent-memory",
      text: "仍由来源拥有",
      origin: "extracted",
      state: "derived",
      sourceThreadId: thread.id,
    });
    core.memory.deleteBySession = async () => {
      throw new Error("memory db unavailable");
    };

    const removeThread = await core.app.inject({
      method: "DELETE",
      url: `/threads/${encodeURIComponent(thread.id)}`,
      headers: { authorization: "Bearer t" },
    });
    expect(removeThread.statusCode).toBe(500);
    expect(removeThread.json()).toMatchObject({ error: "thread_delete_failed" });
    expect(core.repo.getThread(thread.id)?.id).toBe(thread.id);
    expect((await core.memory.list()).map((item) => item.id)).toContain(extracted.id);
  });

  it("deletes a cold persisted pi session file with its Source Conversation", async () => {
    core = makeCore();
    const thread = core.repo.createThread({ title: "冷会话", modelId: "test-model" });
    const sessionFile = path.join(tmpDir!, "pi-agent", "sessions", `${thread.id}.jsonl`);
    fs.writeFileSync(sessionFile, '{"type":"session"}\n', "utf8");

    const removeThread = await core.app.inject({
      method: "DELETE",
      url: `/threads/${encodeURIComponent(thread.id)}`,
      headers: { authorization: "Bearer t" },
    });

    expect(removeThread.statusCode).toBe(200);
    expect(fs.existsSync(sessionFile)).toBe(false);
  });

  it("rejects a late run for a deleted thread without recreating an empty Source Conversation", async () => {
    core = makeCore();
    const thread = core.repo.createThread({
      id: "deleted-thread",
      title: "待删除",
      modelId: "test-model",
    });
    await core.app.inject({
      method: "DELETE",
      url: `/threads/${thread.id}`,
      headers: { authorization: "Bearer t" },
    });

    const lateRun = await core.app.inject({
      method: "POST",
      url: "/agent/run",
      headers: { authorization: "Bearer t" },
      payload: { threadId: thread.id, model: "missing-model", history: [] },
    });

    expect(lateRun.statusCode).toBe(410);
    expect(lateRun.json()).toEqual({ error: "thread_deleted" });
    expect(core.repo.getThread(thread.id)).toBeNull();
  });

  it("keeps a project and its Source Conversation when source-fact deletion fails", async () => {
    core = makeCore();
    const project = core.repo.createProject({
      name: "P",
      workspaceDir: path.join(tmpDir!, "workspace"),
    });
    const thread = core.repo.createThread({ title: "来源", modelId: "m", projectId: project.id });
    const fact = await core.memory.write({
      scope: workspaceScope(project.id),
      layer: "decisions",
      text: "使用 SQLite",
      origin: "extracted",
      state: "derived",
      sourceThreadId: thread.id,
    });
    core.memory.deleteBySession = async () => {
      throw new Error("memory db unavailable");
    };

    const remove = await core.app.inject({
      method: "DELETE",
      url: `/projects/${project.id}`,
      headers: { authorization: "Bearer t" },
    });

    expect(remove.statusCode).toBe(500);
    expect(remove.json()).toMatchObject({ error: "project_delete_failed" });
    expect(core.repo.getProject(project.id)?.id).toBe(project.id);
    expect(core.repo.getThread(thread.id)?.id).toBe(thread.id);
    expect((await core.memory.list()).map((item) => item.id)).toContain(fact.id);
  });

  it("reports workspace-memory cleanup failure instead of claiming project deletion succeeded", async () => {
    core = makeCore();
    const project = core.repo.createProject({
      name: "P",
      workspaceDir: path.join(tmpDir!, "workspace"),
    });
    core.memory.deleteByScope = async () => {
      throw new Error("scope cleanup unavailable");
    };

    const remove = await core.app.inject({
      method: "DELETE",
      url: `/projects/${project.id}`,
      headers: { authorization: "Bearer t" },
    });

    expect(remove.statusCode).toBe(500);
    expect(remove.json()).toMatchObject({ error: "project_delete_failed" });
    expect(core.repo.getProject(project.id)?.id).toBe(project.id);
  });

  it("editing an Extracted Fact through the user API promotes it", async () => {
    core = makeCore();
    const extracted = await core.memory.write({
      layer: "user-profile",
      text: "用户喜欢长回答",
      origin: "extracted",
      state: "derived",
      sourceThreadId: "source-thread",
    });

    const edit = await core.app.inject({
      method: "PATCH",
      url: `/memory/${encodeURIComponent(extracted.id)}`,
      headers: { authorization: "Bearer t" },
      payload: { text: "用户喜欢先给简短结论" },
    });
    expect(edit.statusCode).toBe(200);
    expect(edit.json()).toMatchObject({
      id: extracted.id,
      text: "用户喜欢先给简短结论",
      origin: "extracted",
      state: "curated",
      meta: { promotedBy: "user", promotedFromSourceThreadId: "source-thread" },
    });
    expect(await core.memory.deleteBySession("source-thread")).toBe(0);
  });

  it("creates projects and exposes workspace files through HTTP routes", async () => {
    core = makeCore();
    const workspaceDir = path.join(tmpDir!, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, "notes.txt"), "hello workspace");

    const create = await core.app.inject({
      method: "POST",
      url: "/projects",
      headers: { authorization: "Bearer t" },
      payload: { name: "Test Project", workspaceDir },
    });
    expect(create.statusCode).toBe(200);
    const project = create.json<{ id: string; name: string; workspaceDir: string }>();

    const list = await core.app.inject({
      method: "GET",
      url: `/workspace/${encodeURIComponent(project.id)}/fs/list`,
      headers: { authorization: "Bearer t" },
    });
    expect(list.statusCode).toBe(200);
    expect(
      list.json<{ entries: { path: string }[] }>().entries.map((entry) => entry.path),
    ).toContain("notes.txt");

    const meta = await core.app.inject({
      method: "GET",
      url: `/files/meta?scope=workspace&id=${encodeURIComponent(project.id)}&path=notes.txt`,
      headers: { authorization: "Bearer t" },
    });
    expect(meta.statusCode).toBe(200);
    expect(meta.json()).toMatchObject({ name: "notes.txt", kind: "text", text: "hello workspace" });
  });
});
