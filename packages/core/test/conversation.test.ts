import { describe, it, expect } from "vitest";
import { SqliteConversationRepo } from "../src/store/conversation.js";

function repo(): SqliteConversationRepo {
  return new SqliteConversationRepo(":memory:");
}

describe("SqliteConversationRepo", () => {
  it("创建会话 / 追加消息 / 取历史（按 seq 排序）", () => {
    const r = repo();
    const t = r.createThread({ title: "测试", modelId: "m1" });
    expect(t.id).toBeTruthy();
    r.appendMessage({
      id: "a",
      threadId: t.id,
      role: "user",
      seq: r.nextSeq(t.id),
      parts: [{ type: "text", text: "hi" }],
      createdAt: new Date().toISOString(),
    });
    r.appendMessage({
      id: "b",
      threadId: t.id,
      role: "assistant",
      seq: r.nextSeq(t.id),
      parts: [{ type: "text", text: "hello" }],
      createdAt: new Date().toISOString(),
    });
    const h = r.history(t.id);
    expect(h.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(h[0]!.parts[0]).toEqual({ type: "text", text: "hi" });
    r.close();
  });

  it("resolveThreadForChannel：同一 (kind, userId) 映射到同一 thread", () => {
    const r = repo();
    const t1 = r.resolveThreadForChannel("telegram", "user-42", { modelId: "m" });
    const t2 = r.resolveThreadForChannel("telegram", "user-42");
    expect(t2.id).toBe(t1.id);
    const other = r.resolveThreadForChannel("telegram", "user-99");
    expect(other.id).not.toBe(t1.id);
    expect(t1.channel?.kind).toBe("telegram");
    r.close();
  });

  it("history limit 取最近 N 条仍按 seq 升序", () => {
    const r = repo();
    const t = r.createThread({ modelId: "m" });
    for (let i = 0; i < 5; i++) {
      r.appendMessage({
        id: `m${i}`,
        threadId: t.id,
        role: "user",
        seq: r.nextSeq(t.id),
        parts: [{ type: "text", text: `msg${i}` }],
        createdAt: new Date().toISOString(),
      });
    }
    const h = r.history(t.id, 2);
    expect(h.map((m) => m.parts[0] && (m.parts[0] as any).text)).toEqual(["msg3", "msg4"]);
    r.close();
  });
});
