import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
const rootPackage = readJson("package.json");
const packageLock = readJson("package-lock.json");
const desktopPackage = readJson("apps/desktop/package.json");
const tauriConfig = readJson("apps/desktop/src-tauri/tauri.conf.json");
const cargoToml = fs.readFileSync(path.join(root, "apps/desktop/src-tauri/Cargo.toml"), "utf8");
const cargoLock = fs.readFileSync(path.join(root, "apps/desktop/src-tauri/Cargo.lock"), "utf8");

const argIndex = process.argv.indexOf("--tag");
const tag = argIndex >= 0 ? process.argv[argIndex + 1] : process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined;
const tagMatch = tag?.match(/^v(\d+\.\d+\.\d+)$/);
if (tag && !tagMatch) {
  console.error(`发布标签格式无效: ${tag}（应为 vX.Y.Z）`);
  process.exit(1);
}

const cargoVersion = cargoToml.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const cargoLockVersion = cargoLock.match(/\[\[package\]\]\s+name = "easywork-desktop"\s+version = "([^"]+)"/m)?.[1];
const expected = tagMatch?.[1] ?? rootPackage.version;
const versions = new Map([
  ["package.json", rootPackage.version],
  ["package-lock.json", packageLock.version],
  ["package-lock.json packages root", packageLock.packages?.[""]?.version],
  ["package-lock.json apps/desktop", packageLock.packages?.["apps/desktop"]?.version],
  ["apps/desktop/package.json", desktopPackage.version],
  ["apps/desktop/src-tauri/tauri.conf.json", tauriConfig.version],
  ["apps/desktop/src-tauri/Cargo.toml", cargoVersion],
  ["apps/desktop/src-tauri/Cargo.lock", cargoLockVersion],
]);
const mismatches = [...versions].filter(([, version]) => version !== expected);

if (mismatches.length) {
  console.error(`版本不一致，期望 ${expected}:`);
  for (const [file, version] of mismatches) console.error(`- ${file}: ${version ?? "missing"}`);
  process.exit(1);
}

console.log(`✓ 发布版本一致: ${expected}`);
