import { describe, it, expect } from "vitest";
import type { ChatRequest } from "@ew/shared";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import {
  chatRequestToPiContext,
  piEventToChatStreamEvents,
  newPiAdaptState,
} from "../src/openai-compat/pi-adapt.js";

describe("chatRequestToPiContext", () => {
  it("extracts system, maps user/assistant(+toolCalls)/tool, and tools", () => {
    const req = {
      model: "x",
      messages: [
        { role: "system", content: "be nice" },
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "ok",
          toolCalls: [{ id: "t1", name: "calc", arguments: '{"e":"1+1"}' }],
        },
        { role: "tool", toolCallId: "t1", name: "calc", content: "2" },
      ],
      tools: [{ name: "calc", description: "calc", parameters: { type: "object", properties: {} } }],
    } as ChatRequest;

    const ctx = chatRequestToPiContext(req);
    expect(ctx.systemPrompt).toBe("be nice");
    expect(ctx.messages).toHaveLength(3);
    expect(ctx.messages[0]).toMatchObject({ role: "user", content: "hi" });
    const asst = ctx.messages[1] as { role: string; content: { type: string; name?: string; arguments?: unknown }[] };
    expect(asst.role).toBe("assistant");
    expect(asst.content.find((c) => c.type === "toolCall")).toMatchObject({ name: "calc", arguments: { e: "1+1" } });
    expect(ctx.messages[2]).toMatchObject({ role: "toolResult", toolCallId: "t1", toolName: "calc" });
    expect(ctx.tools?.[0]?.name).toBe("calc");
  });
});

const dev = (e: Partial<AssistantMessageEvent> & { type: string }): AssistantMessageEvent => e as AssistantMessageEvent;

describe("piEventToChatStreamEvents", () => {
  it("maps text/thinking deltas", () => {
    const s = newPiAdaptState();
    expect(piEventToChatStreamEvents(dev({ type: "text_delta", delta: "ab" }), s)).toEqual([{ type: "text-delta", text: "ab" }]);
    expect(piEventToChatStreamEvents(dev({ type: "thinking_delta", delta: "mm" }), s)).toEqual([{ type: "reasoning-delta", text: "mm" }]);
  });

  it("toolcall_end → start+args+end with sequential index", () => {
    const s = newPiAdaptState();
    const out1 = piEventToChatStreamEvents(dev({ type: "toolcall_end", contentIndex: 5, toolCall: { type: "toolCall", id: "a", name: "calc", arguments: { x: 1 } } }), s);
    expect(out1).toEqual([
      { type: "tool-call-start", index: 0, id: "a", name: "calc" },
      { type: "tool-call-args-delta", index: 0, delta: '{"x":1}' },
      { type: "tool-call-end", index: 0 },
    ]);
    const out2 = piEventToChatStreamEvents(dev({ type: "toolcall_end", contentIndex: 9, toolCall: { type: "toolCall", id: "b", name: "g", arguments: {} } }), s);
    expect(out2[0]).toMatchObject({ type: "tool-call-start", index: 1 });
  });

  it("done → usage + done(finishReason mapped, message rebuilt)", () => {
    const s = newPiAdaptState();
    const msg = {
      role: "assistant",
      content: [{ type: "text", text: "hi" }, { type: "toolCall", id: "a", name: "c", arguments: { y: 2 } }],
      usage: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 7, cost: {} },
    };
    const out = piEventToChatStreamEvents(dev({ type: "done", reason: "toolUse", message: msg }), s);
    expect(out[0]).toEqual({ type: "usage", usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 } });
    expect(out[1]).toMatchObject({ type: "done", finishReason: "tool_calls" });
    const done = out[1] as { message: { content: string; toolCalls: { arguments: string }[] } };
    expect(done.message.content).toBe("hi");
    expect(done.message.toolCalls[0]?.arguments).toBe('{"y":2}');
  });

  it("error → error event", () => {
    const s = newPiAdaptState();
    expect(piEventToChatStreamEvents(dev({ type: "error", reason: "error", error: { errorMessage: "boom" } }), s)).toEqual([
      { type: "error", message: "boom" },
    ]);
  });
});
