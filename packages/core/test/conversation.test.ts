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

  it("project CRUD + deleteProject 解除 thread 关联 + listThreads 过滤", () => {
    const r = repo();
    const p = r.createProject({ name: "我的项目", workspaceDir: "/tmp/proj", approvalMode: "auto-edits" });
    expect(p.id).toBeTruthy();
    expect(p.approvalMode).toBe("auto-edits");
    expect(r.getProject(p.id)?.workspaceDir).toBe("/tmp/proj");
    // 默认 approvalMode
    const p2 = r.createProject({ name: "默认审批" });
    expect(p2.approvalMode).toBe("approve-each");
    expect(r.listProjects().length).toBe(2);

    // update
    const u = r.updateProject(p.id, { name: "改名", approvalMode: "full-auto" });
    expect(u.name).toBe("改名");
    expect(u.approvalMode).toBe("full-auto");

    // thread 关联 + 过滤
    const t = r.createThread({ projectId: p.id, modelId: "m", title: "t1" });
    expect(r.listThreads({ projectId: p.id }).map((x) => x.id)).toEqual([t.id]);

    // delete project → 解除 thread 关联，thread 仍在
    r.deleteProject(p.id);
    expect(r.getProject(p.id)).toBeNull();
    expect(r.getThread(t.id)).not.toBeNull();
    expect(r.getThread(t.id)?.projectId).toBeUndefined();
    r.close();
  });

  it("searchMessages：FTS5 全文搜索（含工具调用/结果），按 thread 过滤，删库清索引", () => {
    const r = repo();
    const t1 = r.createThread({ title: "天气会话", modelId: "m" });
    const t2 = r.createThread({ title: "代码会话", modelId: "m" });
    const now = new Date().toISOString();
    r.appendMessage({
      id: "u1", threadId: t1.id, role: "user", seq: r.nextSeq(t1.id),
      parts: [{ type: "text", text: "北京今天天气怎么样" }], createdAt: now,
    });
    r.appendMessage({
      id: "a1", threadId: t1.id, role: "assistant", seq: r.nextSeq(t1.id),
      parts: [], toolCalls: [{ id: "c1", name: "get_weather", arguments: '{"city":"beijing"}' }], createdAt: now,
    });
    r.appendMessage({
      id: "t1m", threadId: t1.id, role: "tool", seq: r.nextSeq(t1.id),
      parts: [{ type: "text", text: "晴 26 度" }], toolResults: [{ content: "晴 26 度" }], createdAt: now,
    });
    r.appendMessage({
      id: "u2", threadId: t2.id, role: "user", seq: r.nextSeq(t2.id),
      parts: [{ type: "text", text: "帮我写个排序算法" }], createdAt: now,
    });

    // 命中正文
    const hw = r.searchMessages("天气");
    expect(hw.some((h) => h.messageId === "u1")).toBe(true);
    // 命中工具名/参数
    expect(r.searchMessages("get_weather").some((h) => h.messageId === "a1")).toBe(true);
    // 命中工具结果文本
    expect(r.searchMessages("26 度").some((h) => h.messageId === "t1m")).toBe(true);
    // 按 thread 过滤
    expect(r.searchMessages("算法", { threadId: t1.id })).toHaveLength(0);
    expect(r.searchMessages("算法", { threadId: t2.id }).length).toBeGreaterThan(0);
    // 短查询（中文 2 字词）走 LIKE 回退仍可命中
    expect(r.searchMessages("天气").some((h) => h.messageId === "u1")).toBe(true);
    // 空查询返回空
    expect(r.searchMessages("  ")).toEqual([]);
    // 高亮片段
    expect(hw.find((h) => h.messageId === "u1")!.snippet).toContain("[");

    // 删库清 FTS 索引
    r.deleteThread(t1.id);
    expect(r.searchMessages("天气")).toEqual([]);
    r.close();
  });
});
