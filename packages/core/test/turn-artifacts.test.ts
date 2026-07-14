import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TurnArtifactSchema } from "@ew/shared";
import { afterEach, describe, expect, it } from "vitest";
import { diffTurnFiles, snapshotTurnFiles } from "../src/agent/turn-artifacts.js";

describe("turn artifacts", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("reports files that still exist at the end of a turn as created or modified", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ew-turn-artifacts-"));
    roots.push(root);
    fs.writeFileSync(path.join(root, "existing.txt"), "before");
    fs.writeFileSync(path.join(root, "removed.txt"), "temporary");
    const before = snapshotTurnFiles(root);

    fs.writeFileSync(path.join(root, "existing.txt"), "after content");
    fs.rmSync(path.join(root, "removed.txt"));
    fs.mkdirSync(path.join(root, "reports"));
    fs.writeFileSync(path.join(root, "reports", "summary.pdf"), "pdf");

    expect(diffTurnFiles(before, snapshotTurnFiles(root))).toEqual([
      { path: "existing.txt", kind: "modified", size: 13 },
      { path: "reports/summary.pdf", kind: "created", size: 3 },
    ]);
  });

  it("skips dependency/cache trees and symlinks", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ew-turn-artifacts-"));
    roots.push(root);
    fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules", "pkg", "index.js"), "ignored");
    fs.writeFileSync(path.join(root, "real.txt"), "ok");
    fs.symlinkSync(path.join(root, "real.txt"), path.join(root, "linked.txt"));

    expect([...snapshotTurnFiles(root).keys()]).toEqual(["real.txt"]);
  });

  it("rejects artifact paths that escape the conversation directory", () => {
    for (const unsafePath of [
      "../secret.txt",
      "nested/../../secret.txt",
      "/tmp/secret.txt",
      "\\temp\\secret.txt",
      "\\\\server\\share\\secret.txt",
      "C:\\temp\\secret.txt",
    ])
      expect(TurnArtifactSchema.safeParse({ path: unsafePath, kind: "created", size: 1 }).success).toBe(false);
  });
});
