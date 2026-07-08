import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

function nodePackageName(id: string): string | null {
  const [, pkgPath] = id.split("/node_modules/");
  if (!pkgPath) return null;
  const parts = pkgPath.split("/");
  return parts[0]?.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0] || null;
}

const markdownPackages = new Set([
  "bail",
  "ccount",
  "comma-separated-tokens",
  "decode-named-character-reference",
  "devlop",
  "escape-string-regexp",
  "hastscript",
  "highlight.js",
  "html-url-attributes",
  "is-plain-obj",
  "lowlight",
  "markdown-table",
  "property-information",
  "react-markdown",
  "rehype-highlight",
  "remark-gfm",
  "space-separated-tokens",
  "trim-lines",
  "trough",
  "unified",
  "zwitch",
]);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "./", // 便于 Electron file:// 加载
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalized = id.replace(/\\/g, "/");
          const pkg = nodePackageName(normalized);
          if (!pkg) return undefined;
          if (pkg === "react" || pkg === "react-dom" || pkg === "scheduler") return "vendor-react";
          if (pkg === "lucide-react") return "vendor-lucide";
          if (pkg === "@lobehub/icons-static-svg" || pkg === "simple-icons") {
            return "vendor-brand-icons";
          }
          if (
            markdownPackages.has(pkg) ||
            pkg.startsWith("estree-util-") ||
            pkg.startsWith("hast-") ||
            pkg.startsWith("hast-util-") ||
            pkg.startsWith("mdast-") ||
            pkg.startsWith("micromark") ||
            pkg.startsWith("parse-entities") ||
            pkg.startsWith("rehype-") ||
            pkg.startsWith("remark-") ||
            pkg.startsWith("space-separated-") ||
            pkg.startsWith("stringify-entities") ||
            pkg.startsWith("trim-trailing-lines") ||
            pkg.startsWith("unist-") ||
            pkg.startsWith("vfile")
          ) {
            return "vendor-markdown";
          }
          return "vendor";
        },
      },
    },
  },
  resolve: {
    alias: {
      "@ew/sdk": path.resolve(import.meta.dirname, "../../packages/sdk/src/index.ts"),
      "@ew/shared": path.resolve(import.meta.dirname, "../../packages/shared/src/index.ts"),
    },
  },
  server: { port: 5173 },
});
