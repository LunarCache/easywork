import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const checker = path.join(repoRoot, "scripts", "check-release-artifacts.mjs");
const cleanup: string[] = [];

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ew-release-artifacts-"));
  cleanup.push(root);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "0.4.4" }));
  for (const dir of [
    "apps/daemon/dist-sea",
    "apps/desktop/src-tauri/target/release/bundle/nsis",
    "apps/desktop/src-tauri/target/release/bundle/msi",
  ]) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, "apps/daemon/dist-sea/easywork.exe"), "exe");
  fs.writeFileSync(path.join(root, "apps/daemon/dist-sea/vec0.dll"), "dll");
  fs.writeFileSync(path.join(root, "apps/desktop/src-tauri/target/release/bundle/nsis/EasyWork_0.4.4_x64-setup.exe"), "nsis");
  fs.writeFileSync(path.join(root, "apps/desktop/src-tauri/target/release/bundle/msi/EasyWork_0.4.4_x64_en-US.msi"), "msi");
  return root;
}

afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("Windows release artifact contract", () => {
  it("accepts a packaged sidecar plus NSIS and MSI installers", () => {
    const result = spawnSync(process.execPath, [checker, "windows", "--root", fixture()], { encoding: "utf8" });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Windows 发布产物完整");
  });

  it("rejects a stale or wrong-architecture installer", () => {
    const root = fixture();
    fs.renameSync(
      path.join(root, "apps/desktop/src-tauri/target/release/bundle/nsis/EasyWork_0.4.4_x64-setup.exe"),
      path.join(root, "apps/desktop/src-tauri/target/release/bundle/nsis/EasyWork_0.4.3_arm64-setup.exe"),
    );

    const result = spawnSync(process.execPath, [checker, "windows", "--root", root, "--bundles", "nsis"], {
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("0.4.4");
    expect(result.stderr).toContain("x64");
  });

  it("rejects an empty bundle selection", () => {
    const result = spawnSync(process.execPath, [checker, "windows", "--root", fixture(), "--bundles", ""], {
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("bundle 参数无效");
  });
});
