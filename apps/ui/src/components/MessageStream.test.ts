import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ToolView } from "./MessageStream.js";

describe("ToolView", () => {
  it("distinguishes tool preflight and approval from execution", () => {
    const base = { id: "call-1", name: "bash", args: '{"command":"npm test"}' };

    const pending = renderToStaticMarkup(createElement(ToolView, { t: { ...base, status: "pending" } }));
    const awaitingApproval = renderToStaticMarkup(
      createElement(ToolView, { t: { ...base, status: "awaiting-approval" } }),
    );

    expect(pending).toContain("准备执行");
    expect(pending).not.toContain("执行中");
    expect(awaitingApproval).toContain("等待审批");
    expect(awaitingApproval).not.toContain("执行中");
  });
});
