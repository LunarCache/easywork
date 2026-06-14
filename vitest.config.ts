import { defineConfig } from "vitest/config";
import path from "node:path";
import os from "node:os";

const r = (p: string) => path.resolve(import.meta.dirname, p);

// 测试期把 @ew/* 解析到各包 src，免去先 build。
export default defineConfig({
  plugins: [
    {
      // Vite 不识别较新的 node:sqlite 内置模块（会误把 node: 前缀剥掉后当成包）。
      // 强制标记为 external，交给 Node 运行时解析。
      name: "externalize-node-sqlite",
      enforce: "pre",
      resolveId(id) {
        if (id === "node:sqlite" || id === "sqlite") return { id: "node:sqlite", external: true };
        return null;
      },
    },
  ],
  resolve: {
    alias: {
      "@ew/shared": r("packages/shared/src/index.ts"),
      "@ew/core": r("packages/core/src/index.ts"),
      "@ew/providers": r("packages/providers/src/index.ts"),
      "@ew/tools": r("packages/tools/src/index.ts"),
      "@ew/skills": r("packages/skills/src/index.ts"),
      "@ew/mcp": r("packages/mcp/src/index.ts"),
      "@ew/memory": r("packages/memory/src/index.ts"),
      "@ew/im-connectors": r("packages/im-connectors/src/index.ts"),
      "@ew/sdk": r("packages/sdk/src/index.ts"),
    },
  },
  // node:sqlite 是较新的内置模块，Vite 默认不识别 → 显式外置，避免被打包解析。
  ssr: { external: ["node:sqlite"] },
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "unsloth/**"],
    environment: "node",
    server: { deps: { external: ["node:sqlite", /node:sqlite/] } },
    // 多个 daemon 测试共享同一数据目录下的 SQLite 文件 → 串行跑文件避免锁竞争。
    fileParallelism: false,
    // 隔离测试数据目录，避免污染 ~/.easywork。
    env: { EW_DATA_DIR: path.join(os.tmpdir(), "ew-vitest-data") },
  },
});
