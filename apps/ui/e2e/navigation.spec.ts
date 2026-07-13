import { test, expect } from "./fixtures.js";

test.describe("navigation e2e", () => {
  test("首页新建工作区直接进入默认空白工作区，目录选择保留为后续显式动作", async ({ page, openApp, client }) => {
    let dialogs = 0;
    page.on("dialog", async (dialog) => {
      dialogs += 1;
      await dialog.dismiss();
    });

    await openApp();
    await page.getByTestId("home-new-workspace").click();

    await expect(page.locator(".ws-hero")).toBeVisible();
    await expect(page.getByTestId("workspace-composer-input")).toBeVisible();
    await expect(page.getByTestId("workspace-project-pill")).toContainText("NewProject1");
    expect(dialogs).toBe(0);

    const projects = await client.listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]?.name).toBe("NewProject1");
    expect(projects[0]?.workspaceDir).toMatch(/[\\/]workspace[\\/]NewProject1$/);

    await page.getByTestId("workspace-project-pill").click();
    await page.getByTestId("workspace-open-folder").click();
    await expect.poll(() => dialogs).toBe(1);
    await expect(page.getByTestId("workspace-project-pill")).toContainText("NewProject1");
  });

  test("标题栏非交互区域都声明为 Tauri 拖拽区", async ({ page, openApp }) => {
    await openApp();

    await expect(page.locator(".ad-titlebar")).toHaveAttribute("data-tauri-drag-region", "true");
    await expect(page.locator(".ad-tb-seg-a")).toHaveAttribute("data-tauri-drag-region", "true");
    await expect(page.locator(".ad-tb-seg-b")).toHaveAttribute("data-tauri-drag-region", "true");
    await expect(page.locator(".ad-tb-task")).toHaveAttribute("data-tauri-drag-region", "true");
    await expect(page.locator(".ad-spacer").first()).toHaveAttribute("data-tauri-drag-region", "true");
    await expect(page.locator("button.ad-tb-nav")).toHaveCount(1);
    await expect(page.locator("button.ad-tb-nav")).not.toHaveAttribute("data-tauri-drag-region", "true");
    await expect(page.locator(".ad-tb-nav-static")).toHaveCount(2);
    await expect(page.locator(".ad-tb-nav-static").first()).toHaveAttribute("data-tauri-drag-region", "true");
  });

  test("macOS 放大工作台时标题避开 traffic lights", async ({ page, openApp }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, "__TAURI__", {
        configurable: true,
        value: { core: { invoke: async () => null } },
      });
    });
    await openApp();

    await page.getByTitle("打开工作台（文件 / 浏览器 / 终端）").click();
    await page.locator(".side-dock .sd-launch-row").filter({ hasText: "文件" }).click();
    await page.getByTitle("放大到窗口").click();

    const title = page.locator(".side-dock.max .sd-top-title");
    await expect(title).toHaveText("文件");
    const titleBox = await title.boundingBox();
    expect(titleBox).not.toBeNull();
    expect(titleBox!.x >= 88 || titleBox!.y >= 46).toBe(true);
  });

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
