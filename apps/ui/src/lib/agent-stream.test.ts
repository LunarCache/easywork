import { describe, expect, it } from "vitest";
import { storedToUiMsgs } from "./agent-stream.js";

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
});
