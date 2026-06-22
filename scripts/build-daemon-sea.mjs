// 把 core daemon 打成单文件原生可执行（Node SEA）。
// 产物：apps/daemon/dist-sea/easywork（+ 同目录 vec0.dylib）。Tauri 以 sidecar 内置、Rust 直接 spawn。
//
// 流程：tsup 全内联 CJS bundle → SEA blob → 注入 node 副本 → (macOS) 重新 ad-hoc 签名 → 随附 sqlite-vec 扩展。
// 仅本机架构（跨架构由各 CI runner 各跑一次）。
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "apps/daemon/dist-sea");
const bundle = path.join(outDir, "easywork-daemon.cjs");
const platform = process.platform;
const exeName = platform === "win32" ? "easywork.exe" : "easywork";
const exe = path.join(outDir, exeName);
const SENTINEL = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

const run = (cmd, opts = {}) => execSync(cmd, { stdio: "inherit", cwd: root, ...opts });

console.log("① 构建 @ew/core（被内联）");
run("npm run build --workspace @ew/core");

console.log("② tsup 全内联 CJS bundle");
run("npx tsup --config tsup.sea.config.ts", { cwd: path.join(root, "apps/daemon") });
if (!fs.existsSync(bundle)) throw new Error(`bundle 未生成: ${bundle}`);

console.log("③ 生成 SEA blob");
const seaCfg = path.join(outDir, "sea-config.json");
const blob = path.join(outDir, "easywork.blob");
fs.writeFileSync(
  seaCfg,
  JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false }),
);
run(`node --experimental-sea-config ${JSON.stringify(seaCfg)}`);

console.log("④ 复制 node 副本并注入 blob");
fs.copyFileSync(process.execPath, exe);
fs.chmodSync(exe, 0o755);
if (platform === "darwin") {
  // 注入前先移除签名，注入后再 ad-hoc 重签（macOS 改二进制后必须重签）。
  try {
    run(`codesign --remove-signature ${JSON.stringify(exe)}`);
  } catch {
    /* 可能本就未签名 */
  }
}
const machoArg = platform === "darwin" ? " --macho-segment-name NODE_SEA" : "";
run(
  `npx --yes postject ${JSON.stringify(exe)} NODE_SEA_BLOB ${JSON.stringify(blob)} --sentinel-fuse ${SENTINEL}${machoArg}`,
);
if (platform === "darwin") run(`codesign --sign - ${JSON.stringify(exe)}`);

console.log("⑤ 随附 sqlite-vec 可加载扩展");
const vecName = platform === "win32" ? "vec0.dll" : platform === "darwin" ? "vec0.dylib" : "vec0.so";
const arch = process.arch; // arm64 / x64
const archPkg = platform === "darwin" ? `sqlite-vec-darwin-${arch}` : platform === "win32" ? `sqlite-vec-windows-${arch}` : `sqlite-vec-linux-${arch}`;
const vecSrc = path.join(root, "node_modules", archPkg, vecName);
if (fs.existsSync(vecSrc)) {
  fs.copyFileSync(vecSrc, path.join(outDir, vecName));
  console.log(`   已随附 ${archPkg}/${vecName}`);
} else {
  console.warn(`   ⚠ 未找到 ${vecSrc}（该平台向量召回将退化为纯词法）`);
}

// 清理中间产物（含 21MB 的 bundle .cjs —— 已注入二进制，无需随发布）。
for (const f of [seaCfg, blob, bundle, `${bundle}.map`]) fs.rmSync(f, { force: true });

const sizeMB = (fs.statSync(exe).size / 1024 / 1024).toFixed(0);
console.log(`\n✓ 单文件 daemon: ${exe} (${sizeMB} MB, ${platform}/${arch})  + ${vecName}`);
console.log(`  自测: ${exeName} serve`);
void os;
