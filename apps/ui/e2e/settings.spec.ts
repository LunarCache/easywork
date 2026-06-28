import { test, expect } from "./fixtures.js";

test.describe("settings e2e", () => {
  test("可打开设置并记住上次分区", async ({ page, openApp }) => {
    await openApp();

    await page.getByTestId("sidebar-settings").click();
    await expect(page.getByTestId("settings-page")).toBeVisible();
    await expect(page.getByTestId("settings-title")).toHaveText("通用");

    await page.getByTestId("settings-nav-memory").click();
    await expect(page.getByTestId("settings-title")).toHaveText("记忆");
    await expect(page.getByTestId("settings-nav-memory")).toHaveAttribute("data-active", "1");
    await expect(page.getByTestId("memory-overlay")).toBeVisible();

    await page.getByTestId("settings-back").click();
    await expect(page.getByTestId("settings-page")).toBeHidden();

    await page.getByTestId("sidebar-settings").click();
    await expect(page.getByTestId("settings-title")).toHaveText("记忆");
    await expect(page.getByTestId("settings-nav-memory")).toHaveAttribute("data-active", "1");

    await page.reload();
    await expect(page.getByTestId("sidebar-settings")).toBeVisible();
    await page.getByTestId("sidebar-settings").click();
    await expect(page.getByTestId("settings-title")).toHaveText("记忆");
  });

  test("模型页可切换本地/云端 tab", async ({ page, openApp }) => {
    await openApp();

    await page.getByTestId("sidebar-settings").click();
    await page.getByTestId("settings-nav-models").click();

    await expect(page.getByTestId("models-page")).toBeVisible();
    await expect(page.getByTestId("models-tab-local")).toHaveAttribute("data-active", "1");

    await page.getByTestId("models-tab-cloud").click();
    await expect(page.getByTestId("models-tab-cloud")).toHaveAttribute("data-active", "1");
    await expect(page.getByText("还没有云端 Provider")).toBeVisible();

    await page.getByTestId("models-tab-local").click();
    await expect(page.getByTestId("models-tab-local")).toHaveAttribute("data-active", "1");
  });

  test("知识库与记忆页主操作按钮可见", async ({ page, openApp, client, workspaceDir }) => {
    const project = await client.createProject({ name: "PW Project", workspaceDir });
    await client.kbIngest({ kbId: "docs", source: "guide.md", text: "# Guide\n\nhello e2e" });
    await client.writeMemory({ scope: `ws:${project.id}`, layer: "conventions", text: "Use playwright for UI e2e." });

    await openApp();
    await page.getByTestId("sidebar-settings").click();

    await page.getByTestId("settings-nav-kb").click();
    await expect(page.getByTestId("kb-overlay")).toBeVisible();
    await expect(page.getByTestId("kb-upload-button")).toBeVisible();
    await expect(page.getByText("guide.md")).toBeVisible();

    await page.getByTestId("settings-nav-memory").click();
    await expect(page.getByTestId("memory-overlay")).toBeVisible();
    await expect(page.getByTestId("memory-add-button")).toBeVisible();
    await expect(page.getByText("Use playwright for UI e2e.")).toBeVisible();
  });
});
