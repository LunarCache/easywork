import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const smoke = path.join(repoRoot, "scripts", "smoke-daemon-sea.mjs");
const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("packaged daemon smoke command", () => {
  it("boots a daemon, verifies /health, and shuts it down", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ew-sea-smoke-"));
    cleanup.push(dir);
    const fakeDaemon = path.join(dir, "fake-daemon.mjs");
    fs.writeFileSync(fakeDaemon, [
      'import http from "node:http";',
      'const server = http.createServer((req, res) => {',
      '  if (req.url === "/health") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, name: "easywork-core" })); }',
      '  else { res.writeHead(404); res.end(); }',
      '});',
      'server.listen(0, "127.0.0.1", () => {',
      '  const address = server.address();',
      '  process.stdout.write(JSON.stringify({ baseUrl: `http://127.0.0.1:${address.port}`, token: "smoke", pid: process.pid }) + "\\n");',
      '});',
      'process.on("SIGTERM", () => { server.closeAllConnections?.(); server.close(() => process.exit(0)); });',
    ].join("\n"));

    const result = spawnSync(process.execPath, [
      smoke,
      "--executable",
      process.execPath,
      "--prefix-arg",
      fakeDaemon,
    ], { encoding: "utf8", timeout: 10_000 });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("SEA daemon smoke 通过");
  });
});
