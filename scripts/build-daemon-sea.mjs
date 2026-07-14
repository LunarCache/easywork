// 把 core daemon 打成单文件原生可执行（Node SEA）。
// 产物：apps/daemon/dist-sea/easywork[.exe]（+ 同目录 vec0.{dylib,dll,so}）。Tauri 以 sidecar 内置、Rust 直接 spawn。
//
// 流程：tsup 全内联 CJS bundle → SEA blob → 注入 node 副本 → (macOS) 重新 ad-hoc 签名 → 随附 sqlite-vec 扩展。
// 仅本机架构（跨架构由各 CI runner 各跑一次）。
import { execFileSync } from "node:child_process";
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

const run = (file, args, opts = {}) => execFileSync(file, args, { stdio: "inherit", cwd: root, ...opts });
const packageBin = (packageName, binName = packageName) => {
  const packageDir = path.join(root, "node_modules", packageName);
  const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
  const relative = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[binName];
  if (!relative) throw new Error(`${packageName} 未声明 ${binName} CLI`);
  return path.join(packageDir, relative);
};
const runPackageBin = (packageName, args, opts = {}) => run(process.execPath, [packageBin(packageName), ...args], opts);

console.log("① 构建全部 @ew/* 包（SEA bundle 全内联，需各包 dist 存在；turbo 按依赖图构建）");
runPackageBin("turbo", ["run", "build"]);

console.log("② tsup 全内联 CJS bundle");
runPackageBin("tsup", ["--config", "tsup.sea.config.ts"], { cwd: path.join(root, "apps/daemon") });
if (!fs.existsSync(bundle)) throw new Error(`bundle 未生成: ${bundle}`);

console.log("③ 生成 SEA blob");
const seaCfg = path.join(outDir, "sea-config.json");
const blob = path.join(outDir, "easywork.blob");
fs.writeFileSync(
  seaCfg,
  JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false }),
);
run(process.execPath, ["--experimental-sea-config", seaCfg]);

console.log("④ 复制 node 副本并注入 blob");
fs.copyFileSync(process.execPath, exe);
if (platform !== "win32") fs.chmodSync(exe, 0o755);
if (platform === "darwin") {
  // 注入前先移除签名，注入后再 ad-hoc 重签（macOS 改二进制后必须重签）。
  try {
    run("codesign", ["--remove-signature", exe]);
  } catch {
    /* 可能本就未签名 */
  }
}
const postjectArgs = [exe, "NODE_SEA_BLOB", blob, "--sentinel-fuse", SENTINEL];
if (platform === "darwin") postjectArgs.push("--macho-segment-name", "NODE_SEA");
runPackageBin("postject", postjectArgs);
if (platform === "darwin") run("codesign", ["--sign", "-", exe]);

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
