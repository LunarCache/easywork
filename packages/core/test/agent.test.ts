import { describe, it, expect } from "vitest";
import type {
  AgentEvent,
  ApprovalGate,
  ChatRequest,
  ChatStreamEvent,
  EngineCapabilities,
  InferenceEngine,
  Tool,
} from "@ew/shared";
import { runAgent } from "../src/agent/loop.js";
import { ToolRegistry } from "../src/agent/tool-registry.js";
import { AutoApproveGate } from "../src/agent/approval.js";

/** 按脚本逐轮输出文本的假引擎（非原生 tool-call）。 */
class ScriptedEngine implements InferenceEngine {
  readonly id = "scripted";
  readonly capabilities: EngineCapabilities = {
    streaming: true,
    nativeToolCalls: false,
    vision: false,
    audio: false,
    embeddings: false,
    jsonSchema: false,
  };
  private i = 0;
  constructor(private readonly turns: string[]) {}
  async chat(req: ChatRequest) {
    return { message: { role: "assistant" as const, content: "" }, finishReason: "stop" as const, model: req.model };
  }
  async *chatStream(): AsyncIterable<ChatStreamEvent> {
    const out = this.turns[this.i++] ?? "完成。";
    yield { type: "text-delta", text: out };
    yield { type: "done", finishReason: "stop", message: { role: "assistant", content: out } };
  }
}

/** 原生 tool-call 引擎：done.message 直接带 toolCalls。 */
class NativeEngine implements InferenceEngine {
  readonly id = "native";
  readonly capabilities: EngineCapabilities = {
    streaming: true,
    nativeToolCalls: true,
    vision: false,
    audio: false,
    embeddings: false,
    jsonSchema: true,
  };
  private i = 0;
  async chat(req: ChatRequest) {
    return { message: { role: "assistant" as const, content: "" }, finishReason: "stop" as const, model: req.model };
  }
  async *chatStream(): AsyncIterable<ChatStreamEvent> {
    if (this.i++ === 0) {
      yield {
        type: "done",
        finishReason: "tool_calls",
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c1", name: "calc", arguments: '{"expr":"1+1"}' }],
        },
      };
    } else {
      yield { type: "text-delta", text: "答案是 2。" };
      yield { type: "done", finishReason: "stop", message: { role: "assistant", content: "答案是 2。" } };
    }
  }
}

function calcTool(calls: { args: unknown }[]): Tool {
  return {
    definition: { name: "calc", description: "计算", parameters: { type: "object", properties: {} } },
    source: "builtin",
    requiresApproval: "never",
    async execute(args) {
      calls.push({ args });
      return { content: "2" };
    },
  };
}

function registryWith(tool: Tool): ToolRegistry {
  const r = new ToolRegistry();
  r.register(tool);
  return r;
}

async function collect(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const baseInput = { threadId: "t", history: [{ role: "user" as const, content: "1+1?" }] };

describe("runAgent", () => {
  it("解析文本中的 tool_call → 执行 → 把结果喂回 → 收尾", async () => {
    const calls: { args: unknown }[] = [];
    const engine = new ScriptedEngine([
      '<tool_call>{"name":"calc","arguments":{"expr":"1+1"}}</tool_call>',
      "结果是 2。",
    ]);
    const events = await collect(
      runAgent(
        { ...baseInput, model: "scripted" },
        { resolveEngine: () => engine, tools: registryWith(calcTool(calls)), approval: new AutoApproveGate(), workspaceDir: "/tmp" },
      ),
    );
    expect(calls).toHaveLength(1);
    expect(events.filter((e) => e.type === "tool-start")).toHaveLength(1);
    const toolEnd = events.find((e) => e.type === "tool-end");
    expect(toolEnd && (toolEnd as any).result.content).toBe("2");
    const final = events.at(-1);
    expect(final?.type).toBe("final");
    expect((final as any).message.content).toBe("结果是 2。");
  });

  it("原生 tool-call 引擎：使用 done.message.toolCalls", async () => {
    const calls: { args: unknown }[] = [];
    const engine = new NativeEngine();
    const events = await collect(
      runAgent(
        { ...baseInput, model: "native" },
        { resolveEngine: () => engine, tools: registryWith(calcTool(calls)), approval: new AutoApproveGate(), workspaceDir: "/tmp" },
      ),
    );
    expect(calls).toHaveLength(1);
    expect(events.find((e) => e.type === "tool-end")).toBeDefined();
    expect((events.at(-1) as any).message.content).toBe("答案是 2。");
  });

  it("重复 tool call 被去重（只执行一次）", async () => {
    const calls: { args: unknown }[] = [];
    const tc = '<tool_call>{"name":"calc","arguments":{"expr":"1+1"}}</tool_call>';
    const engine = new ScriptedEngine([tc, tc, "好了。"]);
    const events = await collect(
      runAgent(
        { ...baseInput, model: "scripted" },
        { resolveEngine: () => engine, tools: registryWith(calcTool(calls)), approval: new AutoApproveGate(), workspaceDir: "/tmp" },
      ),
    );
    expect(calls).toHaveLength(1); // 第二次重复未执行
    expect(events.filter((e) => e.type === "tool-end")).toHaveLength(1);
  });

  it("审批拒绝 → 工具不执行，照常收尾", async () => {
    const calls: { args: unknown }[] = [];
    const denyGate: ApprovalGate = { async request() { return "deny"; } };
    const tool = calcTool(calls);
    tool.requiresApproval = "always";
    const engine = new ScriptedEngine([
      '<tool_call>{"name":"calc","arguments":{"expr":"1+1"}}</tool_call>',
      "已停止。",
    ]);
    const events = await collect(
      runAgent(
        { ...baseInput, model: "scripted" },
        { resolveEngine: () => engine, tools: registryWith(tool), approval: denyGate, workspaceDir: "/tmp" },
      ),
    );
    expect(calls).toHaveLength(0);
    expect(events.find((e) => e.type === "tool-end")).toBeUndefined();
    expect(events.at(-1)?.type).toBe("final");
  });

  it("记忆集成：生成前 recall 注入（memory-recall 事件）+ 生成后 observe", async () => {
    const observed: { sessionId: string }[] = [];
    const memory = {
      id: "fake-mem",
      async recall() {
        return [{ id: "1", layer: "user-profile" as const, text: "用户偏好简洁", updatedAt: "" }];
      },
      async write(i: any) {
        return { id: "x", updatedAt: "", ...i };
      },
      async edit(_id: string) {
        return { id: "x", layer: "user-profile" as const, text: "", updatedAt: "" };
      },
      async list() {
        return [];
      },
      async delete() {},
      async observe(input: { messages: unknown[]; sessionId: string }) {
        observed.push({ sessionId: input.sessionId });
      },
    };
    const engine = new ScriptedEngine(["收到。"]);
    const events = await collect(
      runAgent(
        { ...baseInput, model: "scripted" },
        {
          resolveEngine: () => engine,
          tools: new ToolRegistry(),
          approval: new AutoApproveGate(),
          workspaceDir: "/tmp",
          memory,
        },
      ),
    );
    const recall = events.find((e) => e.type === "memory-recall");
    expect(recall && (recall as any).count).toBe(1);
    expect(observed).toEqual([{ sessionId: "t" }]);
  });

  it("未知工具 → 错误喂回，不崩溃", async () => {
    const engine = new ScriptedEngine([
      '<tool_call>{"name":"ghost","arguments":{}}</tool_call>',
      "抱歉。",
    ]);
    const events = await collect(
      runAgent(
        { ...baseInput, model: "scripted" },
        { resolveEngine: () => engine, tools: new ToolRegistry(), approval: new AutoApproveGate(), workspaceDir: "/tmp" },
      ),
    );
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.at(-1)?.type).toBe("final");
  });

  it("one-shot 工具二次调用不执行（noop）", async () => {
    const calls: { args: unknown }[] = [];
    const tool: Tool = {
      definition: { name: "render_html", description: "渲染", parameters: { type: "object", properties: {} } },
      source: "builtin",
      requiresApproval: "never",
      async execute(args) {
        calls.push({ args });
        return { content: "(已渲染)" };
      },
    };
    // 第一次参数不同→执行；第二次不同参数但同为 one-shot→noop。
    const engine = new ScriptedEngine([
      '<tool_call>{"name":"render_html","arguments":{"code":"<b>a</b>"}}</tool_call>',
      '<tool_call>{"name":"render_html","arguments":{"code":"<b>b</b>"}}</tool_call>',
      "完成。",
    ]);
    const events = await collect(
      runAgent(
        { ...baseInput, model: "scripted" },
        { resolveEngine: () => engine, tools: registryWith(tool), approval: new AutoApproveGate(), workspaceDir: "/tmp" },
      ),
    );
    expect(calls).toHaveLength(1); // 第二次 one-shot 未执行
    expect(events.filter((e) => e.type === "tool-end")).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("final");
  });

  it("累计重复/无效调用达上限 → 强制无工具最终回答轮", async () => {
    const calls: { args: unknown }[] = [];
    const tc = '<tool_call>{"name":"calc","arguments":{"expr":"1+1"}}</tool_call>';
    // 模型一直重复同一调用；首次执行后接连重复，达 noop 上限应被强制收尾。
    const engine = new ScriptedEngine([tc, tc, tc, tc, tc]);
    const events = await collect(
      runAgent(
        { ...baseInput, model: "scripted" },
        { resolveEngine: () => engine, tools: registryWith(calcTool(calls)), approval: new AutoApproveGate(), workspaceDir: "/tmp" },
      ),
    );
    expect(calls).toHaveLength(1); // 只执行一次，其余为 noop
    expect(events.at(-1)?.type).toBe("final"); // 强制收尾而非耗尽迭代
  });
});
