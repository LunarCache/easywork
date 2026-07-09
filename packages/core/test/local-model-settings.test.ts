import { describe, expect, it } from "vitest";
import { LocalModelSettingsStore } from "../src/models/local-model-settings.js";
import { SqliteConversationRepo } from "../src/store/conversation.js";

describe("LocalModelSettingsStore", () => {
  it("persists sampling settings by model id", () => {
    const repo = new SqliteConversationRepo(":memory:");
    const store = new LocalModelSettingsStore(repo);

    expect(store.samplingFor("qwen3")).toBeUndefined();

    store.set("qwen3", { sampling: { temperature: 0.7, topP: 0.9, topK: 40 } });

    const restored = new LocalModelSettingsStore(repo);
    expect(restored.get("qwen3")).toEqual({ sampling: { temperature: 0.7, topP: 0.9, topK: 40 } });
    expect(restored.samplingFor("qwen3")).toEqual({ temperature: 0.7, topP: 0.9, topK: 40 });
  });

  it("removes empty settings", () => {
    const repo = new SqliteConversationRepo(":memory:");
    const store = new LocalModelSettingsStore(repo);

    store.set("qwen3", { sampling: { temperature: 0.2 } });
    store.set("qwen3", { sampling: {} });

    expect(store.get("qwen3")).toEqual({});
    expect(repo.getSetting("models.local.settings")).toBeNull();
  });

  it("ignores corrupt persisted values", () => {
    const repo = new SqliteConversationRepo(":memory:");
    repo.setSetting("models.local.settings", JSON.stringify({ ok: { sampling: { temperature: 0.3 } }, bad: { sampling: { topP: 2 } } }));

    const store = new LocalModelSettingsStore(repo);

    expect(store.get("ok")).toEqual({ sampling: { temperature: 0.3 } });
    expect(store.get("bad")).toEqual({});
  });
});
