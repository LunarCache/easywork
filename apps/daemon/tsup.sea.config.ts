import { defineConfig } from "tsup";

// 单文件二进制（Node SEA）用：把 cli + 全部依赖（@ew/*、pi、其余 npm）内联成一个自包含 JS。
// 仅 node: 内置由 Node 提供；sqlite-vec 是原生可加载扩展，运行时经 EW_SQLITE_VEC 定位（见 resolveVecExtensionPath）。
export default defineConfig({
  entry: { "easywork-daemon": "src/cli.ts" },
  // CJS：Node SEA 的 main 必须是 CommonJS（不支持 ESM main）。CJS 有真实 require，无 dynamic-require 问题。
  format: ["cjs"],
  dts: false,
  clean: true,
  sourcemap: false,
  target: "node22",
  outDir: "dist-sea",
  noExternal: [/.*/],
  external: ["sqlite-vec"],
  splitting: false,
  // CJS 下 import.meta.url 不存在 → 用本文件 URL 顶替（createRequire 可用；SEA 里指向可执行文件，
  // sqlite-vec 经 EW_SQLITE_VEC 兜底）。import.meta.dirname 同理。
  esbuildOptions(options) {
    options.define = {
      ...options.define,
      "import.meta.url": "importMetaUrl",
      "import.meta.dirname": "importMetaDirname",
    };
  },
  banner: {
    js: "const importMetaUrl = require('url').pathToFileURL(__filename).href; const importMetaDirname = __dirname;",
  },
});
