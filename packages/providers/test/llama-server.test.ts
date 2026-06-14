import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import type { ChatStreamEvent } from "@ew/shared";
import { LlamaServerEngine } from "../src/index.js";

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

describe("LlamaServerEngine", () => {
  it("用 --mmproj 启动、轮询 health、委托 chatStream", async () => {
    let spawnedBin = "";
    let spawnedArgs: string[] = [];
    let killed = false;
    const fakeProc = Object.assign(new EventEmitter(), {
      kill: () => {
        killed = true;
        return true;
      },
    });
    const spawnFn = ((bin: string, args: string[]) => {
      spawnedBin = bin;
      spawnedArgs = args;
      return fakeProc;
    }) as never;

    const fakeFetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/health")) return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      if (url.endsWith("/chat/completions")) {
        return sse([
          JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "Red" } }] }),
          JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
        ]);
      }
      throw new Error(`unexpected ${url}`);
    }) as unknown as typeof fetch;

    const engine = new LlamaServerEngine({
      modelPath: "/models/smolvlm.gguf",
      mmprojPath: "/models/mmproj.gguf",
      port: 9999,
      readyTimeoutMs: 3000,
      spawnFn,
      fetch: fakeFetch,
    });

    expect(engine.capabilities.vision).toBe(true);
    await engine.start();

    expect(spawnedBin).toBe("llama-server");
    expect(spawnedArgs).toContain("--mmproj");
    expect(spawnedArgs).toContain("/models/mmproj.gguf");
    expect(spawnedArgs).toContain("-m");
    expect(spawnedArgs).toContain("--jinja");

    const events: ChatStreamEvent[] = [];
    for await (const ev of engine.chatStream({
      model: "local",
      messages: [{ role: "user", content: "hi" }],
    })) {
      events.push(ev);
    }
    const text = events
      .filter((e): e is Extract<ChatStreamEvent, { type: "text-delta" }> => e.type === "text-delta")
      .map((e) => e.text)
      .join("");
    expect(text).toBe("Red");

    await engine.stop();
    expect(killed).toBe(true);
  });

  it("未启动时调用 chatStream 报错", async () => {
    const engine = new LlamaServerEngine({ modelPath: "/m.gguf" });
    await expect(
      (async () => {
        for await (const _ of engine.chatStream({ model: "local", messages: [] })) {
          /* drain */
        }
      })(),
    ).rejects.toThrow();
  });
});
