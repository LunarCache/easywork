import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ChatRequest,
  ChatStreamEvent,
  EngineCapabilities,
  InferenceEngine,
} from "@ew/shared";
import { EasyWorkClient } from "@ew/sdk";
import { createCore, type CoreServer } from "../src/index.js";

/** 消费 /v1/chat/completions 的 OpenAI 风格 SSE，拼回文本。 */
async function streamV1(baseUrl: string, token: string, model: string): Promise<{ text: string; done: boolean }> {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], stream: true }),
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let text = "";
  let done = false;
  for (;;) {
    const { value, done: rdDone } = await reader.read();
    if (rdDone) break;
    buf += dec.decode(value, { stream: true });
    const frames = buf.split("\n\n");
    buf = frames.pop() ?? "";
    for (const f of frames) {
      const line = f.replace(/^data: /, "").trim();
      if (!line) continue;
      if (line === "[DONE]") {
        done = true;
        continue;
      }
      const obj = JSON.parse(line) as { choices?: { delta?: { content?: string } }[] };
      const delta = obj.choices?.[0]?.delta?.content;
      if (delta) text += delta;
    }
  }
  return { text, done };
}

/** 一个不依赖 node-llama-cpp 的假引擎，用于端到端贯通测试。 */
class FakeEngine implements InferenceEngine {
  readonly id = "fake";
  readonly capabilities: EngineCapabilities = {
    streaming: true,
    nativeToolCalls: false,
    vision: false,
    audio: false,
    embeddings: false,
    jsonSchema: false,
  };

  async chat(req: ChatRequest) {
    return {
      message: { role: "assistant" as const, content: "hi" },
      finishReason: "stop" as const,
      model: req.model,
    };
  }

  async *chatStream(_req: ChatRequest): AsyncIterable<ChatStreamEvent> {
    for (const t of ["Hello", ", ", "world", "!"]) {
      yield { type: "text-delta", text: t };
    }
    yield {
      type: "done",
      finishReason: "stop",
      message: { role: "assistant", content: "Hello, world!" },
    };
  }
}

describe("daemon end-to-end (SDK → core → engine)", () => {
  let core: CoreServer | undefined;

  afterEach(async () => {
    await core?.stop();
    core = undefined;
  });

  it("streams chat through the OpenAI-compatible /v1 gateway", async () => {
    core = createCore({ token: "test-token" });
    const fake = new FakeEngine();
    core.registry.register(fake);
    core.registry.routeModel("fake-model", fake);

    const { port, host } = await core.start({ port: 0, host: "127.0.0.1" });
    const baseUrl = `http://${host}:${port}`;
    const client = new EasyWorkClient({ baseUrl, token: "test-token" });

    const health = await client.health();
    expect(health.ok).toBe(true);

    const models = await client.listModels();
    expect(models.routed).toContain("fake-model");

    const { text, done } = await streamV1(baseUrl, "test-token", "fake-model");
    expect(text).toBe("Hello, world!");
    expect(done).toBe(true);
  });

  it("rejects unauthorized requests", async () => {
    core = createCore({ token: "secret" });
    const { port, host } = await core.start({ port: 0, host: "127.0.0.1" });
    const bad = new EasyWorkClient({ baseUrl: `http://${host}:${port}`, token: "wrong" });
    await expect(bad.listModels()).rejects.toThrow();
  });

  it("returns 404 for unloaded model on /v1", async () => {
    core = createCore({ token: "t" });
    const { port, host } = await core.start({ port: 0, host: "127.0.0.1" });
    const res = await fetch(`http://${host}:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ model: "nope", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(404);
  });

  it("exposes the pi-ai provider catalog through the SDK", async () => {
    core = createCore({ token: "t" });
    const { port, host } = await core.start({ port: 0, host: "127.0.0.1" });
    const client = new EasyWorkClient({ baseUrl: `http://${host}:${port}`, token: "t" });

    const catalog = await client.providerCatalog();
    expect(catalog.find((p) => p.id === "openai")?.apiFamilies).toContain("openai-responses");
    expect(catalog.find((p) => p.id === "anthropic")?.apiFamilies).toContain("anthropic-messages");
    expect(catalog.find((p) => p.id === "google")?.modelCount).toBeGreaterThan(0);
    const anthropic = catalog.find((p) => p.id === "anthropic");
    expect(anthropic?.models.length).toBe(anthropic?.modelCount);
    expect(anthropic?.models[0]).toMatchObject({
      id: expect.any(String),
      contextWindow: expect.any(Number),
      inputModalities: expect.arrayContaining(["text"]),
    });
  });

  it("probes OpenAI-compatible provider model lists through the SDK", async () => {
    const upstream: typeof fetch = async (input, init) => {
      expect(String(input)).toBe("https://models.example.test/v1/models");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
      return new Response(JSON.stringify({ data: [{ id: "model-a" }, { id: "model-b" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    core = createCore({ token: "t", fetch: upstream });
    const { port, host } = await core.start({ port: 0, host: "127.0.0.1" });
    const client = new EasyWorkClient({ baseUrl: `http://${host}:${port}`, token: "t" });

    await expect(client.probeProviderModels({ baseUrl: "https://models.example.test/v1", apiKey: "sk-test" }))
      .resolves.toEqual(["model-a", "model-b"]);
  });

  it("returns global skill sources and annotates discovered skills", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ew-skill-source-"));
    const skillDir = path.join(root, "global-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      `---
name: Global Skill
description: test skill
whenToUse: tests
---
# Global Skill`,
    );
    try {
      core = createCore({
        token: "t",
        dbPath: ":memory:",
        memoryDbPath: ":memory:",
        kbDbPath: ":memory:",
        skillsDirs: [root],
      });
      const res = await core.app.inject({ method: "GET", url: "/skills", headers: { authorization: "Bearer t" } });
      expect(res.statusCode).toBe(200);
      const body = res.json<{
        dir: string;
        sources: { id: string; kind: string; primary?: boolean; dir: string }[];
        skills: { id: string; source: { id: string; kind: string; primary?: boolean } }[];
      }>();
      expect(body.dir).toBe(path.resolve(root));
      expect(body.sources[0]).toMatchObject({ id: "builtin", kind: "builtin", primary: true, dir: path.resolve(root) });
      expect(body.skills[0]).toMatchObject({ id: "global-skill", source: { id: "builtin", kind: "builtin" } });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the pi agent skills directory as the default global skills directory", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ew-skill-default-"));
    const previousDataDir = process.env.EW_DATA_DIR;
    process.env.EW_DATA_DIR = root;
    try {
      core = createCore({
        token: "t",
        dbPath: ":memory:",
        memoryDbPath: ":memory:",
        kbDbPath: ":memory:",
      });
      const res = await core.app.inject({ method: "GET", url: "/skills", headers: { authorization: "Bearer t" } });
      expect(res.statusCode).toBe(200);
      const body = res.json<{
        dir: string;
        sources: { id: string; kind: string; primary?: boolean; dir: string }[];
      }>();
      const expected = path.join(root, "pi-agent", "skills");
      expect(body.dir).toBe(expected);
      expect(body.sources.map((source) => source.id)).toEqual(["builtin", "agents"]);
      expect(body.sources[0]).toMatchObject({ id: "builtin", kind: "builtin", primary: true, dir: expected });
    } finally {
      if (previousDataDir === undefined) delete process.env.EW_DATA_DIR;
      else process.env.EW_DATA_DIR = previousDataDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
