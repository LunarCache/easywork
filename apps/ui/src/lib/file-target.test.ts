import { describe, expect, it } from "vitest";
import { matchFileTarget } from "./file-target.js";

describe("matchFileTarget", () => {
  it("matches Windows and POSIX absolute targets to relative list entries", () => {
    const files = [{ path: "pages/weather.html", type: "file" as const }];

    expect(matchFileTarget(files, "/tmp/chat/pages/weather.html")?.path).toBe("pages/weather.html");
    expect(matchFileTarget(files, "C:\\chat\\pages\\weather.html")?.path).toBe("pages/weather.html");
  });

  it("prefers the longest path suffix over a shorter basename suffix", () => {
    const files = [
      { path: "index.html", type: "file" as const },
      { path: "pages/index.html", type: "file" as const },
    ];

    expect(matchFileTarget(files, "/tmp/chat/pages/index.html")?.path).toBe("pages/index.html");
  });

  it("does not guess when only an ambiguous basename matches", () => {
    const files = [
      { path: "a/index.html", type: "file" as const },
      { path: "b/index.html", type: "file" as const },
    ];

    expect(matchFileTarget(files, "index.html")).toBeUndefined();
  });
});
