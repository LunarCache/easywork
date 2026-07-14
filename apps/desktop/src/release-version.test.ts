import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../../..");
const script = path.join(root, "scripts", "check-release-version.mjs");
const { version } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version: string };

describe("release version manifests", () => {
  it("matches the current release tag", () => {
    const result = spawnSync(process.execPath, [script, "--tag", `v${version}`], { cwd: root, encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("rejects a tag that differs from the packaged version", () => {
    const result = spawnSync(process.execPath, [script, "--tag", "v9.9.9"], { cwd: root, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("版本不一致");
  });
});
