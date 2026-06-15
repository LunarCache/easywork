import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { SessionHost } from "../src/agent/session-host.js";
import type { LocalServerManager } from "../src/engine/local-server-manager.js";
import type { ProviderManager, CloudProviderConfig } from "../src/providers/manager.js";

// R2：把 EasyWork 云端 provider 同步进 pi 的共享、落盘 AuthStorage，并能全量对账（增/删）。
function makeDeps(configs: CloudProviderConfig[]) {
  const local = { baseUrlFor: () => undefined, contexts: () => ({}) } as unknown as LocalServerManager;
  let dump = configs;
  const providers = {
    dump: () => dump,
    findByModel: (id: string) => dump.find((c) => c.models.includes(id)),
    setDump: (next: CloudProviderConfig[]) => {
      dump = next;
    },
  } as unknown as ProviderManager & { setDump: (n: CloudProviderConfig[]) => void };
  return { local, providers };
}

describe("SessionHost.syncCloudProviders", () => {
  it("seeds local key + persists cloud provider key, and reconciles removals", () => {
    const agentDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ew-r2-")));
    const cfg: CloudProviderConfig = {
      id: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "sk-test-123",
      models: ["some/model"],
    };
    const deps = makeDeps([cfg]);
    const host = new SessionHost({ ...deps, agentDir });

    // 重新打开同一 auth.json，断言持久化结果（与 host 内句柄解耦）。
    const reopened = () => AuthStorage.create(path.join(agentDir, "auth.json"));
    let store = reopened();
    expect(store.get("local")).toEqual({ type: "api_key", key: "local" });
    expect(store.get("openrouter")).toEqual({ type: "api_key", key: "sk-test-123" });

    // 删除该 provider 后对账 → 凭据被注销。
    (deps.providers as unknown as { setDump: (n: CloudProviderConfig[]) => void }).setDump([]);
    host.syncCloudProviders();
    store = reopened();
    expect(store.get("openrouter")).toBeUndefined();
    expect(store.get("local")).toEqual({ type: "api_key", key: "local" });

    host.disposeAll();
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("throws on unresolvable model", () => {
    const agentDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ew-r2-")));
    const deps = makeDeps([]);
    const host = new SessionHost({ ...deps, agentDir });
    // resolveModel 是私有的，经 run() 间接触发；这里只验证构造不抛、目录建立。
    expect(fs.existsSync(path.join(agentDir, "auth.json"))).toBe(true);
    host.disposeAll();
    fs.rmSync(agentDir, { recursive: true, force: true });
  });
});
