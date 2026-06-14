import { describe, it, expect } from "vitest";
import { parseToolCallsFromText, stripToolCallMarkup } from "../src/agent/healing.js";

describe("parseToolCallsFromText — JSON 形式", () => {
  it("标准 <tool_call>{json}</tool_call>", () => {
    const tc = parseToolCallsFromText(
      '<tool_call>{"name":"web_search","arguments":{"query":"hello world"}}</tool_call>',
    );
    expect(tc).toHaveLength(1);
    expect(tc[0]!.name).toBe("web_search");
    expect(JSON.parse(tc[0]!.arguments)).toEqual({ query: "hello world" });
  });

  it("缺少闭合标签也能解析（大括号平衡）", () => {
    const tc = parseToolCallsFromText('<tool_call>{"name":"x","arguments":{"a":1}}');
    expect(tc).toHaveLength(1);
    expect(JSON.parse(tc[0]!.arguments)).toEqual({ a: 1 });
  });

  it("字符串内的大括号/转义引号不破坏平衡", () => {
    const tc = parseToolCallsFromText(
      '<tool_call>{"name":"run","arguments":{"code":"if (x) {\\"y\\"}"}}</tool_call>',
    );
    expect(tc).toHaveLength(1);
    expect(JSON.parse(tc[0]!.arguments)).toEqual({ code: 'if (x) {"y"}' });
  });

  it("多个 JSON tool_call", () => {
    const tc = parseToolCallsFromText(
      '<tool_call>{"name":"a","arguments":{}}</tool_call> 中间 <tool_call>{"name":"b","arguments":{"k":2}}</tool_call>',
    );
    expect(tc.map((t) => t.name)).toEqual(["a", "b"]);
    expect(tc[0]!.id).toBe("call_0");
    expect(tc[1]!.id).toBe("call_1");
  });

  it("坏 JSON 被跳过", () => {
    expect(parseToolCallsFromText('<tool_call>{not json')).toHaveLength(0);
  });
});

describe("parseToolCallsFromText — XML function/parameter 形式", () => {
  it("单参数", () => {
    const tc = parseToolCallsFromText(
      "<function=web_search><parameter=query>weather in SF</parameter></function>",
    );
    expect(tc[0]!.name).toBe("web_search");
    expect(JSON.parse(tc[0]!.arguments)).toEqual({ query: "weather in SF" });
  });

  it("单参数缺闭合标签", () => {
    const tc = parseToolCallsFromText("<function=get_time><parameter=tz>UTC");
    expect(tc[0]!.name).toBe("get_time");
    expect(JSON.parse(tc[0]!.arguments)).toEqual({ tz: "UTC" });
  });

  it("多参数", () => {
    const tc = parseToolCallsFromText(
      "<function=move><parameter=from>a</parameter><parameter=to>b</parameter></function>",
    );
    expect(JSON.parse(tc[0]!.arguments)).toEqual({ from: "a", to: "b" });
  });

  it("dashed 名字（MCP 命名空间 + 带连字符参数）", () => {
    const tc = parseToolCallsFromText(
      "<function=mcp__srv__list-issues><parameter=issue-number>5</parameter></function>",
    );
    expect(tc[0]!.name).toBe("mcp__srv__list-issues");
    expect(JSON.parse(tc[0]!.arguments)).toEqual({ "issue-number": "5" });
  });

  it("单参数值含代码（仅去尾部闭合标签）", () => {
    const tc = parseToolCallsFromText(
      "<function=run><parameter=code>console.log(1)</parameter></function>",
    );
    expect(JSON.parse(tc[0]!.arguments)).toEqual({ code: "console.log(1)" });
  });

  it("JSON 优先：有 JSON 时不走 XML 分支", () => {
    const tc = parseToolCallsFromText(
      '<tool_call>{"name":"j","arguments":{}}</tool_call><function=x><parameter=a>1</parameter></function>',
    );
    expect(tc).toHaveLength(1);
    expect(tc[0]!.name).toBe("j");
  });

  it("无 tool call 返回空", () => {
    expect(parseToolCallsFromText("just some text")).toEqual([]);
  });
});

describe("stripToolCallMarkup", () => {
  it("closed 模式只移除已闭合块", () => {
    const out = stripToolCallMarkup('before<tool_call>{"x":1}</tool_call>after<tool_call>{partial');
    expect(out).toBe("beforeafter<tool_call>{partial");
  });

  it("final 模式移除尾部未闭合块并 trim", () => {
    const out = stripToolCallMarkup('  hello <tool_call>{"x":1}</tool_call> world <function=y><parameter=a>1', {
      final: true,
    });
    expect(out).toBe("hello  world");
  });

  it("function 闭合块移除", () => {
    const out = stripToolCallMarkup("a<function=f><parameter=p>v</parameter></function>b");
    expect(out).toBe("ab");
  });
});
