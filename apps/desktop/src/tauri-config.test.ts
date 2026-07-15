import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Tauri desktop security config", () => {
  it("ships a CSP that keeps Tauri IPC and the local daemon reachable", () => {
    const configPath = path.resolve(import.meta.dirname, "../src-tauri/tauri.conf.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      app?: { security?: { csp?: Record<string, string[]> | null } };
    };
    const csp = config.app?.security?.csp;

    expect(csp).toBeTruthy();
    expect(csp?.["default-src"]).toContain("'self'");
    expect(csp?.["connect-src"]).toEqual(expect.arrayContaining(["ipc:", "http://ipc.localhost", "http://127.0.0.1:*"]));
    expect(csp?.["img-src"]).toEqual(expect.arrayContaining(["data:", "blob:"]));
    expect(csp?.["frame-src"]).toEqual(expect.arrayContaining(["data:", "blob:"]));
    expect(csp?.["object-src"]).toEqual(["'none'"]);
    expect(csp?.["base-uri"]).toEqual(["'self'"]);
  });

  it("grants IPC permissions only to the bundled main webview", () => {
    const capabilityPath = path.resolve(import.meta.dirname, "../src-tauri/capabilities/default.json");
    const capability = JSON.parse(fs.readFileSync(capabilityPath, "utf8")) as {
      windows?: string[];
      webviews?: string[];
      remote?: unknown;
    };

    expect(capability.windows).toBeUndefined();
    expect(capability.webviews).toEqual(["main"]);
    expect(capability.remote).toBeUndefined();
  });
});
