import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentSessionStore } from "../src/agent/session-store.js";

describe("AgentSessionStore", () => {
  it("creates agent directories and tunes compaction reserve tokens", () => {
    const agentDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ew-session-store-")));
    try {
      new AgentSessionStore(agentDir);
      const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
      expect(settings.compaction.reserveTokens).toBe(2048);
      expect(fs.existsSync(path.join(agentDir, "sessions"))).toBe(true);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("reads the last assistant usage from a pi session log", () => {
    const agentDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ew-session-usage-")));
    try {
      const store = new AgentSessionStore(agentDir);
      const file = path.join(agentDir, "sessions", "thread-a.jsonl");
      fs.writeFileSync(
        file,
        [
          JSON.stringify({
            message: {
              role: "assistant",
              usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 3, totalTokens: 19 },
            },
          }),
          "not json",
          JSON.stringify({
            message: {
              role: "assistant",
              usage: { input: 20, output: 5, cacheRead: 7, cacheWrite: 0, totalTokens: 32 },
            },
          }),
        ].join("\n"),
        "utf8",
      );

      expect(store.lastUsage("thread-a")).toEqual({
        promptTokens: 27,
        completionTokens: 5,
        totalTokens: 32,
      });
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("ignores aborted/error or zero-token assistant usage records", () => {
    const agentDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "ew-session-usage-abort-")),
    );
    try {
      const store = new AgentSessionStore(agentDir);
      const file = path.join(agentDir, "sessions", "thread-abort.jsonl");
      fs.writeFileSync(
        file,
        [
          JSON.stringify({
            message: {
              role: "assistant",
              stopReason: "stop",
              usage: { input: 12, output: 4, cacheRead: 1, cacheWrite: 0, totalTokens: 17 },
            },
          }),
          JSON.stringify({
            message: {
              role: "assistant",
              stopReason: "aborted",
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
            },
          }),
          JSON.stringify({
            message: {
              role: "assistant",
              stopReason: "error",
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
            },
          }),
          JSON.stringify({
            message: {
              role: "assistant",
              stopReason: "stop",
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
            },
          }),
        ].join("\n"),
        "utf8",
      );

      expect(store.lastUsage("thread-abort")).toEqual({
        promptTokens: 13,
        completionTokens: 4,
        totalTokens: 17,
      });
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("strict thread deletion propagates a persisted-session removal failure", () => {
    const agentDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ew-session-delete-")));
    try {
      const store = new AgentSessionStore(agentDir);
      const file = path.join(agentDir, "sessions", "blocked.jsonl");
      fs.mkdirSync(file);
      fs.writeFileSync(path.join(file, "child"), "cannot remove as a file");

      expect(() => store.deleteThreadSessionFile("blocked")).toThrow();
      expect(fs.existsSync(file)).toBe(true);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
