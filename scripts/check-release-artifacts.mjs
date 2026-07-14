import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const platform = args[0];
const rootArg = args.indexOf("--root");
const bundlesArg = args.indexOf("--bundles");
const bundles = new Set((bundlesArg >= 0 ? args[bundlesArg + 1] : "nsis,msi").split(",").filter(Boolean));
const root = rootArg >= 0
  ? path.resolve(args[rootArg + 1] ?? "")
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function requireFile(relative) {
  const file = path.join(root, relative);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`缺少发布产物: ${relative}`);
  return relative;
}

function requireInstaller(relativeDir, extension, version) {
  const dir = path.join(root, relativeDir);
  const file = fs.existsSync(dir)
    ? fs.readdirSync(dir).find((name) => {
      const lower = name.toLowerCase();
      return lower.endsWith(extension) && lower.includes(`_${version.toLowerCase()}_x64`);
    })
    : undefined;
  if (!file) throw new Error(`缺少当前版本 Windows x64 发布产物: ${relativeDir}/*_${version}_x64*${extension}`);
  return path.join(relativeDir, file);
}

try {
  if (platform !== "windows") throw new Error(`不支持的发布平台: ${platform ?? "missing"}`);
  if (!bundles.size || [...bundles].some((bundle) => bundle !== "nsis" && bundle !== "msi")) {
    throw new Error(`Windows bundle 参数无效: ${[...bundles].join(",") || "empty"}`);
  }
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const version = typeof packageJson.version === "string" ? packageJson.version : "";
  if (!version) throw new Error("package.json 缺少有效 version");
  const files = [
    requireFile("apps/daemon/dist-sea/easywork.exe"),
    requireFile("apps/daemon/dist-sea/vec0.dll"),
  ];
  if (bundles.has("nsis")) {
    files.push(requireInstaller("apps/desktop/src-tauri/target/release/bundle/nsis", ".exe", version));
  }
  if (bundles.has("msi")) {
    files.push(requireInstaller("apps/desktop/src-tauri/target/release/bundle/msi", ".msi", version));
  }
  console.log(`✓ Windows 发布产物完整:\n${files.map((file) => `- ${file}`).join("\n")}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
