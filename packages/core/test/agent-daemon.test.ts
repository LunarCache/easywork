import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentEvent } from "@ew/shared";
import { createCore, type CoreServer } from "../src/index.js";

const enc = new TextEncoder();
function sse(frames: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(`data: ${f}\n\n`));
      c.enqueue(enc.encode("data: [DONE]\n\n"));
      c.close();
    },
  });
  return new Response(stream, { status: 200 });
}

/** 假云端：第一次返回 calculator 的 tool_call，第二次返回最终答案。 */
function makeUpstream(): typeof fetch {
  let call = 0;
  return (async (_input: RequestInfo | URL) => {
    call++;
    if (call === 1) {
      return sse([
        JSON.stringify({
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [{ index: 0, id: "c1", function: { name: "calculator", arguments: "" } }],
              },
            },
          ],
        }),
        JSON.stringify({
          choices: [
            { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"expression":"6*7"}' } }] } },
          ],
        }),
        JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
      ]);
    }
    return sse([
      JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "答案是 42。" } }] }),
      JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    ]);
  }) as unknown as typeof fetch;
}

async function collectAgentSSE(res: Response): Promise<AgentEvent[]> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const out: AgentEvent[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const line = buf.slice(0, idx).replace(/^data:\s?/, "");
      buf = buf.slice(idx + 2);
      if (line === "[DONE]" || !line.trim()) continue;
      out.push(JSON.parse(line) as AgentEvent);
    }
  }
  return out;
}

describe("/agent/run 端到端（云端原生 tool_call → 内置 calculator → 收尾）", () => {
  let core: CoreServer | undefined;
  afterEach(async () => {
    await core?.stop();
    core = undefined;
  });

  it("跑通工具调用循环并把结果喂回模型", async () => {
    core = createCore({ token: "t", fetch: makeUpstream(), skillsDirs: [] });
    core.providers.add({ id: "cloud", baseUrl: "http://up.test/v1", models: ["cloud-x"] });
    const { port, host } = await core.start({ port: 0, host: "127.0.0.1" });

    const res = await fetch(`http://${host}:${port}/agent/run`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({
        threadId: "x",
        model: "cloud-x",
        history: [{ role: "user", content: "6 乘 7 等于几？" }],
      }),
    });
    expect(res.status).toBe(200);

    const events = await collectAgentSSE(res);
    const toolStart = events.find((e) => e.type === "tool-start");
    expect(toolStart && (toolStart as any).call.name).toBe("calculator");
    const toolEnd = events.find((e) => e.type === "tool-end");
    expect(toolEnd && (toolEnd as any).result.content).toBe("42");
    const final = events.at(-1);
    expect(final?.type).toBe("final");
    expect((final as any).message.content).toBe("答案是 42。");
  });
});

describe("工作区项目端点", () => {
  let core: CoreServer | undefined;
  let dir: string | undefined;
  let base = "";
  const h = { authorization: "Bearer t", "content-type": "application/json" };

  afterEach(async () => {
    await core?.stop();
    core = undefined;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("创建项目（校验目录）+ fs/list + fs/read 越界 400", async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ew-wsep-")));
    fs.writeFileSync(path.join(dir, "readme.md"), "# hi");
    core = createCore({ token: "t", skillsDirs: [], dbPath: ":memory:", memoryDbPath: ":memory:" });
    const { port, host } = await core.start({ port: 0, host: "127.0.0.1" });
    base = `http://${host}:${port}`;

    // 无效目录 → 400
    const bad = await fetch(`${base}/projects`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ name: "x", workspaceDir: "/no/such/dir/xyz" }),
    });
    expect(bad.status).toBe(400);

    // 有效目录 → 创建
    const created = await fetch(`${base}/projects`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ name: "我的项目", workspaceDir: dir, approvalMode: "auto-edits" }),
    });
    expect(created.status).toBe(200);
    const project = (await created.json()) as { id: string; approvalMode: string };
    expect(project.approvalMode).toBe("auto-edits");

    // 列出
    const list = await fetch(`${base}/projects`, { headers: h });
    expect(((await list.json()) as { projects: unknown[] }).projects).toHaveLength(1);

    // fs/list
    const fl = await fetch(`${base}/workspace/${project.id}/fs/list?path=.`, { headers: h });
    const entries = ((await fl.json()) as { entries: { path: string }[] }).entries;
    expect(entries.some((e) => e.path === "readme.md")).toBe(true);

    // fs/read 正常
    const fr = await fetch(`${base}/workspace/${project.id}/fs/read?path=readme.md`, { headers: h });
    expect(((await fr.json()) as { content: string }).content).toContain("# hi");

    // fs/read 越界 → 400
    const esc = await fetch(`${base}/workspace/${project.id}/fs/read?path=../../etc/passwd`, { headers: h });
    expect(esc.status).toBe(400);
  });

  it("未指定目录 → 回落到数据目录下的默认工作区并自动创建", async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ew-datadir-")));
    const prev = process.env.EW_DATA_DIR;
    process.env.EW_DATA_DIR = dir;
    try {
      core = createCore({ token: "t", skillsDirs: [], dbPath: ":memory:", memoryDbPath: ":memory:" });
      const { port, host } = await core.start({ port: 0, host: "127.0.0.1" });
      base = `http://${host}:${port}`;
      const created = await fetch(`${base}/projects`, {
        method: "POST",
        headers: h,
        body: JSON.stringify({ name: "默认" }),
      });
      expect(created.status).toBe(200);
      const p = (await created.json()) as { workspaceDir: string };
      expect(p.workspaceDir).toBe(path.join(dir, "workspace"));
      expect(fs.existsSync(p.workspaceDir)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.EW_DATA_DIR;
      else process.env.EW_DATA_DIR = prev;
    }
  });

  it("/agent/run 带工作区项目：fs_write 工具真实写盘（auto-edits 免审批）", async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ew-wsrun-")));
    // 假云端：第一次调 fs_write，第二次收尾。
    let call = 0;
    const upstream = (async () => {
      call++;
      if (call === 1) {
        return sse([
          JSON.stringify({
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  tool_calls: [{ index: 0, id: "w1", function: { name: "fs_write", arguments: "" } }],
                },
              },
            ],
          }),
          JSON.stringify({
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    { index: 0, function: { arguments: JSON.stringify({ path: "hello.txt", content: "你好\n" }) } },
                  ],
                },
              },
            ],
          }),
          JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
        ]);
      }
      return sse([
        JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "已创建 hello.txt。" } }] }),
        JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
      ]);
    }) as unknown as typeof fetch;

    core = createCore({ token: "t", fetch: upstream, skillsDirs: [], dbPath: ":memory:", memoryDbPath: ":memory:" });
    core.providers.add({ id: "cloud", baseUrl: "http://up.test/v1", models: ["cloud-x"] });
    const { port, host } = await core.start({ port: 0, host: "127.0.0.1" });
    base = `http://${host}:${port}`;

    const created = await fetch(`${base}/projects`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ name: "p", workspaceDir: dir, approvalMode: "auto-edits" }),
    });
    const project = (await created.json()) as { id: string };

    const res = await fetch(`${base}/agent/run`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({
        threadId: `ws-${project.id}`,
        model: "cloud-x",
        projectId: project.id,
        history: [{ role: "user", content: "创建 hello.txt" }],
      }),
    });
    const events = await collectAgentSSE(res);
    const toolEnd = events.find((e) => e.type === "tool-end");
    expect(toolEnd && (toolEnd as any).call.name).toBe("fs_write");
    // 真实写盘
    expect(fs.readFileSync(path.join(dir, "hello.txt"), "utf8")).toBe("你好\n");
    // diff display 透传
    expect((toolEnd as any).result.display?.kind).toBe("diff");
  });

  it("git 端点：status / stage / commit 流程", async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ew-wsgit-")));
    const g = (...a: string[]) => execFileSync("git", a, { cwd: dir!, stdio: "ignore" });
    g("init", "-q");
    g("config", "user.email", "t@t.com");
    g("config", "user.name", "t");
    g("config", "commit.gpgsign", "false");
    fs.writeFileSync(path.join(dir, "f.txt"), "v1\n");
    g("add", "-A");
    g("commit", "-qm", "init");
    fs.writeFileSync(path.join(dir, "f.txt"), "v2\nv3\n");

    core = createCore({ token: "t", skillsDirs: [], dbPath: ":memory:", memoryDbPath: ":memory:" });
    const { port, host } = await core.start({ port: 0, host: "127.0.0.1" });
    base = `http://${host}:${port}`;
    const created = await fetch(`${base}/projects`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ name: "g", workspaceDir: dir }),
    });
    const id = ((await created.json()) as { id: string }).id;

    const st = (await (await fetch(`${base}/workspace/${id}/git/status`, { headers: h })).json()) as {
      repo: boolean;
      files: { path: string; unstaged: boolean }[];
    };
    expect(st.repo).toBe(true);
    expect(st.files.find((f) => f.path === "f.txt")?.unstaged).toBe(true);

    const dif = (await (await fetch(`${base}/workspace/${id}/git/diff?path=f.txt`, { headers: h })).json()) as {
      diff: string;
    };
    expect(dif.diff).toContain("+v3");

    await fetch(`${base}/workspace/${id}/git/stage`, { method: "POST", headers: h, body: JSON.stringify({ all: true }) });
    const commit = (await (
      await fetch(`${base}/workspace/${id}/git/commit`, {
        method: "POST",
        headers: h,
        body: JSON.stringify({ message: "update f" }),
      })
    ).json()) as { ok: boolean };
    expect(commit.ok).toBe(true);

    const after = (await (await fetch(`${base}/workspace/${id}/git/status`, { headers: h })).json()) as {
      files: unknown[];
    };
    expect(after.files).toHaveLength(0);

    // 路径沙箱：git diff 越界路径 → 400（不泄露工作区外文件）
    const esc = await fetch(`${base}/workspace/${id}/git/diff?path=../../../../etc/passwd`, { headers: h });
    expect(esc.status).toBe(400);
    // 未知项目 git/branches → 400（projectRoot 抛错被捕获，非 500）
    const nb = await fetch(`${base}/workspace/no-such-id/git/branches`, { headers: h });
    expect(nb.status).toBe(400);
  });
});
