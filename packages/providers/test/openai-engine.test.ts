import { describe, it, expect } from "vitest";
import type { ChatStreamEvent } from "@ew/shared";
import { OpenAICompatibleEngine, toOpenAIMessages } from "../src/index.js";

describe("toOpenAIMessages — reasoning 不发给模型", () => {
  it("reasoning part 被剔除，answer text 保留（不变成 [reasoning] 占位）", () => {
    const out = toOpenAIMessages([
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "内部思考不该外发" },
          { type: "text", text: "最终答案" },
        ],
      },
    ]) as { role: string; content: unknown }[];
    expect(out[0]!.content).toBe("最终答案");
    expect(JSON.stringify(out)).not.toContain("[reasoning]");
    expect(JSON.stringify(out)).not.toContain("内部思考");
  });
});

const enc = new TextEncoder();

function sseResponse(frames: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(`data: ${f}\n\n`));
      controller.enqueue(enc.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("OpenAICompatibleEngine.chatStream", () => {
  it("解析文本增量与原生 tool_calls 增量", async () => {
    const frames = [
      JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "Hello" } }] }),
      JSON.stringify({ choices: [{ index: 0, delta: { content: " world" } }] }),
      JSON.stringify({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, id: "call_1", function: { name: "get_weather", arguments: "" } }],
            },
          },
        ],
      }),
      JSON.stringify({
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] } }],
      }),
      JSON.stringify({
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"SF"}' } }] } }],
      }),
      JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
    ];
    const fakeFetch = (async () => sseResponse(frames)) as unknown as typeof fetch;

    const engine = new OpenAICompatibleEngine({ id: "fake", baseUrl: "http://x", fetch: fakeFetch });
    const events: ChatStreamEvent[] = [];
    for await (const ev of engine.chatStream({ model: "m", messages: [{ role: "user", content: "hi" }] })) {
      events.push(ev);
    }

    const text = events.filter((e) => e.type === "text-delta").map((e) => (e as any).text).join("");
    expect(text).toBe("Hello world");

    const start = events.find((e) => e.type === "tool-call-start") as any;
    expect(start.name).toBe("get_weather");

    const done = events.at(-1) as any;
    expect(done.type).toBe("done");
    expect(done.finishReason).toBe("tool_calls");
    expect(done.message.toolCalls[0].name).toBe("get_weather");
    expect(done.message.toolCalls[0].arguments).toBe('{"city":"SF"}');
  });

  it("采样参数透传到请求体（含 llama.cpp 扩展 top_k/min_p/repeat_penalty）", async () => {
    let captured: any;
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      captured = JSON.parse(init.body as string);
      return new Response(
        JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const engine = new OpenAICompatibleEngine({ id: "fake", baseUrl: "http://x", fetch: fakeFetch });
    await engine.chat({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.7,
      topP: 0.9,
      topK: 40,
      minP: 0.05,
      repeatPenalty: 1.1,
      frequencyPenalty: 0.2,
      presencePenalty: 0.3,
      reasoningEffort: "high",
    });
    expect(captured.temperature).toBe(0.7);
    expect(captured.top_p).toBe(0.9);
    expect(captured.top_k).toBe(40);
    expect(captured.min_p).toBe(0.05);
    expect(captured.repeat_penalty).toBe(1.1);
    expect(captured.frequency_penalty).toBe(0.2);
    expect(captured.presence_penalty).toBe(0.3);
    expect(captured.reasoning_effort).toBe("high");
  });

  it("非流式 chat() 解析 message + usage", async () => {
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({
          model: "m",
          choices: [{ index: 0, message: { role: "assistant", content: "hi there" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    const engine = new OpenAICompatibleEngine({ id: "fake", baseUrl: "http://x", fetch: fakeFetch });
    const res = await engine.chat({ model: "m", messages: [{ role: "user", content: "hi" }] });
    expect(res.message.content).toBe("hi there");
    expect(res.usage?.totalTokens).toBe(7);
    expect(res.finishReason).toBe("stop");
  });
});
