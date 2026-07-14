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
    await page.getByTitle("放大到窗口").click();

    const activeTab = page.locator(".side-dock.max .sd-top").getByTestId("side-dock-tab-files");
    await expect(activeTab).toHaveText(/文件/);
    const activeTabBox = await activeTab.boundingBox();
    expect(activeTabBox).not.toBeNull();
    expect(activeTabBox!.x >= 88 || activeTabBox!.y >= 46).toBe(true);
  });

  test("工作台使用顶层动态标签，并支持输入自定义浏览器地址", async ({ page, openApp }) => {
    await openApp();
    await page.getByTitle("打开工作台（文件 / 浏览器 / 终端）").click();

    const dock = page.getByTestId("side-dock");
    await expect(dock.locator(".sd-top-title")).toHaveCount(0);
    await expect(dock.locator(".sd-top").getByTestId("side-dock-tab-files")).toBeVisible();
    await expect(page.getByTestId("side-dock-tab-preview")).toHaveCount(0);

    await page.getByTestId("side-dock-add-view").click();
    const menu = page.getByTestId("side-dock-view-menu");
    await expect(menu).toBeVisible();
    await menu.getByRole("menuitem", { name: "浏览器" }).click();
    await expect(page.getByTestId("side-dock-tab-preview")).toHaveClass(/on/);

    const address = page.getByRole("textbox", { name: "浏览器地址" });
    await address.fill("example.com/docs");
    await address.press("Enter");
    await expect(address).toHaveValue("https://example.com/docs");
    await expect(page.locator(".side-dock .wpv-frame")).toHaveAttribute("src", "https://example.com/docs");

    await address.fill("file:///etc/passwd");
    await address.press("Enter");
    await expect(page.locator(".side-dock .wpv-error")).toContainText("http(s)");
    await expect(page.locator(".side-dock .wpv-frame")).toHaveAttribute("src", "https://example.com/docs");
    await address.fill("https://example.com/docs");

    await page.getByTestId("side-dock-add-view").click();
    await page.getByTestId("side-dock-view-menu").getByRole("menuitem", { name: "终端" }).click();
    await expect(page.getByTestId("side-dock-tab-terminal")).toHaveClass(/on/);
    await expect(page.getByTestId("side-dock-tab-preview")).toBeVisible();
    await page.getByTestId("side-dock-tab-preview").click();
    await expect(address).toHaveValue("https://example.com/docs");
  });

  test("消息链接在重复点击时会重新激活浏览器标签", async ({ page, openApp, info }) => {
    await page.route(`${info.baseUrl}/models`, async (route) => {
      await route.fulfill({
        json: {
          routed: ["test-model"],
          modelSources: [{ id: "test-model", kind: "engine", label: "Test", modelId: "test-model" }],
          context: { "test-model": 32_768 },
          engines: [],
        },
      });
    });
    await page.route(`${info.baseUrl}/agent/run`, async (route) => {
      const content = "查看 [示例页面](https://example.com/docs)。";
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: [
          `data: ${JSON.stringify({ type: "text", text: content })}\n\n`,
          `data: ${JSON.stringify({ type: "final", message: { role: "assistant", content } })}\n\n`,
          "data: [DONE]\n\n",
        ].join(""),
      });
    });

    await openApp();
    await page.getByTestId("chat-composer-input").fill("给我一个链接");
    await page.getByTestId("chat-composer-input").press("Enter");

    const link = page.getByRole("link", { name: "示例页面" });
    await link.click();
    const address = page.getByRole("textbox", { name: "浏览器地址" });
    await expect(page.getByTestId("side-dock-tab-preview")).toHaveClass(/on/);
    await expect(address).toHaveValue("https://example.com/docs");

    await address.fill("example.org/other");
    await address.press("Enter");
    await page.getByTestId("side-dock-add-view").click();
    await page.getByTestId("side-dock-view-menu").getByRole("menuitem", { name: "终端" }).click();
    await expect(page.getByTestId("side-dock-tab-terminal")).toHaveClass(/on/);

    await link.click();
    await expect(page.getByTestId("side-dock-tab-preview")).toHaveClass(/on/);
    await expect(address).toHaveValue("https://example.com/docs");
  });

  test("工作台宽度可拖拽并持久化，窄窗口改为浮层而不是消失", async ({ page, openApp }) => {
    await openApp();
    const toggle = page.getByTitle("打开工作台（文件 / 浏览器 / 终端）");
    await toggle.click();

    const dock = page.getByTestId("side-dock");
    const handle = page.getByTestId("side-dock-resize-handle");
    const before = await dock.boundingBox();
    const grip = await handle.boundingBox();
    expect(before).not.toBeNull();
    expect(grip).not.toBeNull();

    await page.mouse.move(grip!.x + grip!.width / 2, grip!.y + 80);
    await page.mouse.down();
    await page.mouse.move(grip!.x - 90, grip!.y + 80);
    await page.mouse.up();
    const after = await dock.boundingBox();
    expect(after!.width).toBeGreaterThan(before!.width + 60);

    // reload 强制 SideDock 重挂载，确认宽度来自 localStorage，而不是仍在内存中的 React state。
    await page.reload();
    await page.getByTitle("打开工作台（文件 / 浏览器 / 终端）").click();
    await expect.poll(async () => (await dock.boundingBox())?.width ?? 0).toBeGreaterThan(before!.width + 60);

    const persistedGrip = await handle.boundingBox();
    await page.mouse.move(persistedGrip!.x + persistedGrip!.width / 2, persistedGrip!.y + 80);
    await page.mouse.down();
    await page.mouse.move(persistedGrip!.x - 2_000, persistedGrip!.y + 80);
    await page.mouse.up();
    await expect.poll(async () => Math.round((await dock.boundingBox())?.width ?? 0)).toBe(760);

    const maxGrip = await handle.boundingBox();
    await page.mouse.move(maxGrip!.x + maxGrip!.width / 2, maxGrip!.y + 80);
    await page.mouse.down();
    await page.mouse.move(maxGrip!.x + 2_000, maxGrip!.y + 80);
    await page.mouse.up();
    await expect.poll(async () => Math.round((await dock.boundingBox())?.width ?? 0)).toBe(320);

    await page.setViewportSize({ width: 960, height: 720 });
    await expect(page.getByTitle("关闭工作台")).toBeVisible();
    await expect(dock).toBeVisible();
    await expect.poll(() => dock.evaluate((element) => getComputedStyle(element).position)).toBe("fixed");
    const narrow = await dock.boundingBox();
    expect(narrow!.width).toBeLessThanOrEqual(960);
    expect(narrow!.x + narrow!.width).toBeGreaterThanOrEqual(959);

    await page.getByTitle("关闭工作台").click();
    const narrowToggle = page.getByTitle("打开工作台（文件 / 浏览器 / 终端）");
    await expect(narrowToggle).toBeVisible();
    await narrowToggle.click();
    await expect(dock).toBeVisible();
    await expect.poll(() => dock.evaluate((element) => getComputedStyle(element).position)).toBe("fixed");
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
