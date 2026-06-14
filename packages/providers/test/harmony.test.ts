import { describe, it, expect } from "vitest";
import { HarmonyParser } from "../src/harmony.js";

function run(chunks: string[]): { reasoning: string; text: string; isHarmony: boolean } {
  const p = new HarmonyParser();
  let reasoning = "";
  let text = "";
  for (const c of chunks) {
    const seg = p.push(c);
    reasoning += seg.reasoning ?? "";
    text += seg.text ?? "";
  }
  const tail = p.flush();
  reasoning += tail.reasoning ?? "";
  text += tail.text ?? "";
  return { reasoning, text, isHarmony: p.isHarmony };
}

describe("HarmonyParser", () => {
  it("普通文本（无 harmony 标记）原样作为 text", () => {
    const r = run(["你好", "，世界"]);
    expect(r.text).toBe("你好，世界");
    expect(r.reasoning).toBe("");
    expect(r.isHarmony).toBe(false);
  });

  it("analysis → reasoning，final → text，剥离控制 token", () => {
    const r = run([
      "<|channel|>analysis<|message|>先想一想<|end|>",
      "<|start|>assistant<|channel|>final<|message|>最终答案<|return|>",
    ]);
    expect(r.reasoning).toBe("先想一想");
    expect(r.text).toBe("最终答案");
    expect(r.isHarmony).toBe(true);
  });

  it("控制 token 跨 chunk 边界被正确缓冲", () => {
    // 把 <|channel|> 拆成两块
    const r = run(["<|chan", "nel|>analysis<|mess", "age|>思考内容<|end|>", "<|channel|>final<|message|>答案"]);
    expect(r.reasoning).toBe("思考内容");
    expect(r.text).toBe("答案");
  });

  it("commentary 通道也归为 reasoning", () => {
    const r = run(["<|channel|>commentary<|message|>注释<|end|><|channel|>final<|message|>正文<|return|>"]);
    expect(r.reasoning).toBe("注释");
    expect(r.text).toBe("正文");
  });
});
