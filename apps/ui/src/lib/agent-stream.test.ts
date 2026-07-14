import { describe, expect, it } from "vitest";
import { applyAgentEvent, storedToUiMsgs, toolDisplayPatch } from "./agent-stream.js";

describe("storedToUiMsgs", () => {
  it("preserves stored timestamps on user and assistant conversation turns", () => {
    const userAt = "2026-07-14T13:04:00.000Z";
    const assistantAt = "2026-07-14T13:05:30.000Z";

    expect(
      storedToUiMsgs([
        { role: "user", parts: [{ type: "text", text: "hello" }], createdAt: userAt },
        { role: "assistant", parts: [{ type: "text", text: "hi" }], createdAt: assistantAt },
      ]),
    ).toEqual([
      { role: "user", raw: "hello", reasoning: "", tools: [], displayAt: Date.parse(userAt) },
      {
        role: "assistant",
        raw: "hi",
        reasoning: "",
        tools: [],
        blocks: [{ kind: "text", text: "hi" }],
        displayAt: Date.parse(assistantAt),
      },
    ]);
  });

  it("renders HTML display only while restoring historical messages", () => {
    const display = { kind: "html", html: "<h1>legacy</h1>", title: "Legacy" };

    expect(toolDisplayPatch(display)).toEqual({});
    expect(toolDisplayPatch(display, true)).toEqual({ html: "<h1>legacy</h1>", htmlTitle: "Legacy" });
  });

  it("uses the final stored entry time for an assistant turn containing tool messages", () => {
    const answerAt = "2026-07-14T13:06:00.000Z";
    const messages = storedToUiMsgs([
      {
        role: "user",
        parts: [{ type: "text", text: "inspect" }],
        createdAt: "2026-07-14T13:04:00.000Z",
      },
      {
        role: "assistant",
        parts: [],
        toolCalls: [{ id: "call-1", name: "read", arguments: "{}" }],
        createdAt: "2026-07-14T13:05:00.000Z",
      },
      {
        role: "tool",
        parts: [{ type: "text", text: "done" }],
        toolResults: [{ content: "done" }],
        createdAt: "2026-07-14T13:05:30.000Z",
      },
      { role: "assistant", parts: [{ type: "text", text: "finished" }], createdAt: answerAt },
    ]);

    expect(messages[1]?.displayAt).toBe(Date.parse(answerAt));
  });

  it("restores persisted artifacts and accepts live artifact events", () => {
    const artifacts = [{ path: "reports/summary.pdf", kind: "created" as const, size: 2048 }];
    const stored = storedToUiMsgs([
      { role: "user", parts: [{ type: "text", text: "make a report" }] },
      { role: "assistant", parts: [{ type: "text", text: "done" }], artifacts },
    ]);

    expect(stored[1]?.artifacts).toEqual(artifacts);
    expect(
      applyAgentEvent(
        { role: "assistant", raw: "done", reasoning: "", tools: [] },
        { type: "artifacts", artifacts },
      ).artifacts,
    ).toEqual(artifacts);
  });
});
