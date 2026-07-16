import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const tauriRoot = path.resolve(import.meta.dirname, "../src-tauri");

describe("Desktop icon asset contract", () => {
  it("reruns the Rust build when a platform icon changes", () => {
    const buildScript = fs.readFileSync(path.join(tauriRoot, "build.rs"), "utf8");

    expect(buildScript).toContain("cargo:rerun-if-changed=icons");
  });
});
