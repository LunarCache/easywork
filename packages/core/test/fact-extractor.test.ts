import { describe, it, expect } from "vitest";
import type { ChatRequest, ChatResponse, InferenceEngine } from "@ew/shared";
import { buildFactExtractor } from "../src/memory/fact-extractor.js";

/** 假引擎：固定回某段文本作为模型输出。记录收到的请求。 */
function fakeEngine(reply: string, sink?: ChatRequest[]): InferenceEngine {
  return {
    id: "fake",
    capabilities: {
      streaming: true,
      nativeToolCalls: false,
      vision: false,
      audio: false,
      embeddings: false,
      jsonSchema: true,
    },
    async chat(req: ChatRequest): Promise<ChatResponse> {
      sink?.push(req);
      return { message: { role: "assistant", content: reply }, finishReason: "stop", model: req.model };
    },
    chatStream() {
      throw new Error("unused");
    },
  };
}

const convo = [
  { role: "user", content: "我是后端工程师，偏好简洁回答" },
  { role: "assistant", content: "好的" },
];

describe("buildFactExtractor", () => {
  it("解析标准 JSON，仅保留合法分层", async () => {
    const reply = JSON.stringify({
      facts: [
        { layer: "user-profile", text: "用户是后端工程师" },
        { layer: "agent-memory", text: "偏好简洁回答" },
        { layer: "bogus-layer", text: "应丢弃" },
        { layer: "skills", text: "   " }, // 空文本丢弃
      ],
    });
    const extract = buildFactExtractor({ resolveEngine: () => fakeEngine(reply) });
    const facts = await extract({ messages: convo, existing: [], model: "m" });
    expect(facts).toEqual([
      { layer: "user-profile", text: "用户是后端工程师" },
      { layer: "agent-memory", text: "偏好简洁回答" },
    ]);
  });

  it("从围栏/前后缀文本中截出 JSON 对象", async () => {
    const reply = '好的，结果如下：\n```json\n{"facts":[{"layer":"skills","text":"用 jq 解析"}]}\n```\n完毕';
    const extract = buildFactExtractor({ resolveEngine: () => fakeEngine(reply) });
    const facts = await extract({ messages: convo, existing: [], model: "m" });
    expect(facts).toEqual([{ layer: "skills", text: "用 jq 解析" }]);
  });

  it("无 model / 模型未路由 / 非 JSON → 安全返回 []", async () => {
    const noModel = buildFactExtractor({ resolveEngine: () => fakeEngine("{}") });
    expect(await noModel({ messages: convo, existing: [] })).toEqual([]);

    const unrouted = buildFactExtractor({
      resolveEngine: () => {
        throw new Error("没有引擎可服务模型");
      },
    });
    expect(await unrouted({ messages: convo, existing: [], model: "m" })).toEqual([]);

    const garbage = buildFactExtractor({ resolveEngine: () => fakeEngine("抱歉，我无法抽取") });
    expect(await garbage({ messages: convo, existing: [], model: "m" })).toEqual([]);
  });

  it("空对话不调用引擎", async () => {
    const sink: ChatRequest[] = [];
    const extract = buildFactExtractor({ resolveEngine: () => fakeEngine("{}", sink) });
    const facts = await extract({ messages: [{ role: "tool", content: "x" }], existing: [], model: "m" });
    expect(facts).toEqual([]);
    expect(sink).toHaveLength(0);
  });

  it("把已有记忆与对话注入 prompt（供模型去重）", async () => {
    const sink: ChatRequest[] = [];
    const extract = buildFactExtractor({ resolveEngine: () => fakeEngine('{"facts":[]}', sink) });
    await extract({
      messages: convo,
      existing: [{ layer: "user-profile", text: "用户喜欢猫" }],
      model: "m",
    });
    const userMsg = sink[0]!.messages.find((m) => m.role === "user")!;
    const text = typeof userMsg.content === "string" ? userMsg.content : "";
    expect(text).toContain("用户喜欢猫");
    expect(text).toContain("我是后端工程师");
  });
});
