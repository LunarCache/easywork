import { describe, it, expect } from "vitest";
import type { ChatStreamEvent } from "@ew/shared";
import {
  anthropicToChatRequest,
  chatResponseToAnthropic,
  AnthropicStreamTranslator,
} from "../src/openai-compat/anthropic.js";

interface AnthropicMessageResponseShape {
  type: string;
  stop_reason: string;
  content: unknown[];
  usage: { input_tokens: number };
}

describe("Anthropic ↔ ChatRequest 翻译", () => {
  it("system + 文本消息 + 工具定义 → ChatRequest", () => {
    const req = anthropicToChatRequest({
      model: "m",
      system: "你是助手",
      max_tokens: 100,
      temperature: 0.5,
      top_k: 20,
      messages: [{ role: "user", content: "你好" }],
      tools: [{ name: "calc", description: "计算", input_schema: { type: "object", properties: {} } }],
    });
    expect(req.messages[0]).toEqual({ role: "system", content: "你是助手" });
    expect(req.messages[1]).toEqual({ role: "user", content: "你好" });
    expect(req.maxTokens).toBe(100);
    expect(req.temperature).toBe(0.5);
    expect(req.topK).toBe(20);
    expect(req.tools?.[0]?.name).toBe("calc");
  });

  it("tool_use / tool_result 块 → toolCalls + tool 角色消息", () => {
    const req = anthropicToChatRequest({
      model: "m",
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu1", name: "calc", input: { x: 1 } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu1", content: "2" }],
        },
      ],
    });
    const assistant = req.messages.find((m) => m.role === "assistant");
    expect(assistant?.toolCalls?.[0]).toMatchObject({ id: "tu1", name: "calc" });
    const tool = req.messages.find((m) => m.role === "tool");
    expect(tool).toMatchObject({ toolCallId: "tu1", content: "2" });
  });

  it("ChatResponse → Anthropic message（含 tool_use 块 + stop_reason）", () => {
    const out = chatResponseToAnthropic(
      {
        message: { role: "assistant", content: "结果", toolCalls: [{ id: "t1", name: "calc", arguments: '{"x":1}' }] },
        finishReason: "tool_calls",
        usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
      },
      "msg_1",
      "m",
    ) as AnthropicMessageResponseShape;
    expect(out.type).toBe("message");
    expect(out.stop_reason).toBe("tool_use");
    expect(out.content[0]).toEqual({ type: "text", text: "结果" });
    expect(out.content[1]).toMatchObject({ type: "tool_use", id: "t1", name: "calc", input: { x: 1 } });
    expect(out.usage.input_tokens).toBe(5);
  });

  it("流式翻译器产出合法 Anthropic SSE 事件序列", () => {
    const tr = new AnthropicStreamTranslator("msg_1", "m");
    const frames: string[] = [tr.start()];
    const events: ChatStreamEvent[] = [
      { type: "text-delta", text: "你好" },
      { type: "text-delta", text: "世界" },
      { type: "tool-call-start", index: 0, id: "t1", name: "calc" },
      { type: "tool-call-args-delta", index: 0, delta: '{"x":1}' },
      { type: "tool-call-end", index: 0 },
      { type: "done", finishReason: "tool_calls", message: { role: "assistant", content: "你好世界" } },
    ];
    for (const e of events) {
      const f = tr.event(e);
      if (f) frames.push(f);
    }
    frames.push(tr.end());
    const all = frames.join("");
    expect(all).toContain("event: message_start");
    expect(all).toContain('"type":"content_block_start"');
    expect(all).toContain('"type":"text_delta","text":"你好"');
    expect(all).toContain('"type":"tool_use","id":"t1","name":"calc"');
    expect(all).toContain('"type":"input_json_delta","partial_json":"{\\"x\\":1}"');
    expect(all).toContain('"stop_reason":"tool_use"');
    expect(all).toContain("event: message_stop");
  });
});
