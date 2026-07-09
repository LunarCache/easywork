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
    expect(list.json<{ items: { text: string }[] }>().items.map((item) => item.text)).toEqual(["用户偏好简洁回答"]);

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
    expect(list.json<{ entries: { path: string }[] }>().entries.map((entry) => entry.path)).toContain("notes.txt");

    const meta = await core.app.inject({
      method: "GET",
      url: `/files/meta?scope=workspace&id=${encodeURIComponent(project.id)}&path=notes.txt`,
      headers: { authorization: "Bearer t" },
    });
    expect(meta.statusCode).toBe(200);
    expect(meta.json()).toMatchObject({ name: "notes.txt", kind: "text", text: "hello workspace" });
  });
});
