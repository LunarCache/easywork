import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  base: "./", // 便于 Electron file:// 加载
  resolve: {
    alias: {
      "@ew/sdk": path.resolve(import.meta.dirname, "../../packages/sdk/src/index.ts"),
      "@ew/shared": path.resolve(import.meta.dirname, "../../packages/shared/src/index.ts"),
    },
  },
  server: { port: 5173 },
});
