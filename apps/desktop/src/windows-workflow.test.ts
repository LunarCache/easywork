import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../../..");

function jobBlock(workflow: string, jobName: string): string {
  const marker = `  ${jobName}:`;
  const start = workflow.indexOf(marker);
  expect(start, `missing workflow job ${jobName}`).toBeGreaterThanOrEqual(0);
  const rest = workflow.slice(start + marker.length);
  const nextJob = rest.search(/\n[ ]{2}[A-Za-z0-9_-]+:\n/);
  return nextJob >= 0 ? rest.slice(0, nextJob) : rest;
}

function expectInOrder(source: string, values: string[]): void {
  let offset = -1;
  for (const value of values) {
    const next = source.indexOf(value);
    expect(next, `missing ${value}`).toBeGreaterThan(offset);
    offset = next;
  }
}

describe("Windows desktop build workflows", () => {
  it("uses Node 24-based official actions on ordinary CI", () => {
    const workflow = fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");

    expect(workflow).toContain("actions/checkout@v7");
    expect(workflow).toContain("actions/setup-node@v6");
    expect(workflow).toContain("actions/cache@v5");
    expect(workflow).toContain("actions/upload-artifact@v6");
    expect(workflow).not.toMatch(/actions\/(checkout|setup-node|cache|upload-artifact)@v4/);
  });

  it("builds, smokes, checks, and publishes both Windows installers on release tags", () => {
    const workflow = jobBlock(
      fs.readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8"),
      "build-windows",
    );

    expect(workflow).toContain("windows-latest");
    expect(workflow).toContain("bundle/nsis/*.exe");
    expect(workflow).toContain("bundle/msi/*.msi");
    expectInOrder(workflow, [
      "Clean stale Windows bundles",
      "--bundles nsis,msi",
      "npm run smoke:daemon-sea",
      "npm run release:check-artifacts -- windows",
      "Upload Windows installers to Release",
    ]);
  });

  it("exercises the Windows NSIS build on ordinary CI changes", () => {
    const workflow = jobBlock(
      fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8"),
      "windows-build",
    );

    expect(workflow).toContain("windows-latest");
    expectInOrder(workflow, [
      "Clean stale Windows bundles",
      "--bundles nsis",
      "npm run smoke:daemon-sea",
      "npm run release:check-artifacts -- windows --bundles nsis",
      "Upload Windows CI installer",
    ]);
  });

  it("propagates a cancelled or failed Windows installer exit code", () => {
    const installer = fs.readFileSync(path.join(root, "install.ps1"), "utf8");

    expect(installer).toContain("-PassThru");
    expect(installer).toContain("$installerProcess.ExitCode");
  });
});
