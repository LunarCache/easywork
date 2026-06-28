import { test, expect } from "./fixtures.js";

test.describe("navigation e2e", () => {
  test("全局搜索可通过快捷键打开并切换到目标工作区", async ({ page, openApp, client, workspaceDir }) => {
    const alpha = await client.createProject({ name: "Alpha Search Workspace", workspaceDir });
    const beta = await client.createProject({ name: "Beta Search Workspace", workspaceDir });

    await openApp();

    await page.keyboard.press("Control+K");
    await expect(page.getByTestId("search-overlay")).toBeVisible();
    await expect(page.getByTestId("search-input")).toBeFocused();

    await page.getByTestId("search-input").fill("Beta Search");
    await expect(page.getByTestId(`search-item-project-${beta.id}`)).toBeVisible();
    await expect(page.getByTestId(`search-item-project-${alpha.id}`)).toHaveCount(0);

    await page.getByTestId("search-input").press("Enter");
    await expect(page.getByTestId("search-overlay")).toHaveCount(0);
    await expect(page.getByTestId("workspace-composer-input")).toBeVisible();
    await expect(page.getByTestId("workspace-project-pill")).toContainText("Beta Search Workspace");
  });

  test("工作区上下文条可搜索并切换项目", async ({ page, openApp, client, workspaceDir }) => {
    const alpha = await client.createProject({ name: "Alpha Context Workspace", workspaceDir });
    const beta = await client.createProject({ name: "Beta Context Workspace", workspaceDir });

    await openApp();
    await page.getByTestId(`sidebar-project-${alpha.id}`).click();
    await expect(page.getByTestId("workspace-project-pill")).toContainText("Alpha Context Workspace");

    await page.getByTestId("workspace-project-pill").click();
    await expect(page.getByTestId("workspace-project-menu")).toBeVisible();

    const search = page.getByTestId("workspace-project-search");
    await search.fill("Beta Context");
    await expect(page.getByTestId(`workspace-project-option-${beta.id}`)).toBeVisible();
    await expect(page.getByTestId(`workspace-project-option-${alpha.id}`)).toHaveCount(0);

    await page.getByTestId(`workspace-project-option-${beta.id}`).click();
    await expect(page.getByTestId("workspace-project-menu")).toHaveCount(0);
    await expect(page.getByTestId("workspace-project-pill")).toContainText("Beta Context Workspace");
    await expect(page.getByTestId("workspace-composer-input")).toHaveAttribute(
      "placeholder",
      /Beta Context Workspace/,
    );
  });

  test("搜索面板可从侧栏打开并用 Esc 关闭", async ({ page, openApp }) => {
    await openApp();

    await page.getByTestId("sidebar-search").click();
    await expect(page.getByTestId("search-overlay")).toBeVisible();
    await expect(page.getByTestId("search-input")).toBeFocused();

    await page.getByTestId("search-input").fill("definitely-no-match");
    await expect(page.getByTestId("search-empty")).toBeVisible();

    await page.getByTestId("search-input").press("Escape");
    await expect(page.getByTestId("search-overlay")).toHaveCount(0);
  });
});
