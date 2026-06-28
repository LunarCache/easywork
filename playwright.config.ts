import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const uiPort = Number(process.env.EW_E2E_UI_PORT ?? 4173);

export default defineConfig({
  testDir: path.join("apps", "ui", "e2e"),
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"], ["html", { open: "never" }]],
  outputDir: path.join("test-results", "playwright"),
  use: {
    baseURL: `http://127.0.0.1:${uiPort}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: process.env.EW_PLAYWRIGHT_USE_WEB_SERVER
    ? {
        command: `npm run dev --workspace @ew/ui -- --host 0.0.0.0 --port ${uiPort}`,
        url: `http://127.0.0.1:${uiPort}`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      }
    : undefined,
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
