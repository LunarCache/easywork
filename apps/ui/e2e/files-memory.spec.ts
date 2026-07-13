import { test, expect } from "./fixtures.js";

test.describe("files and memory e2e", () => {
  test("可从侧栏进入文件页并返回任务视图", async ({ page, openApp, client, workspaceDir }) => {
    const project = await client.createProject({ name: "Files Workspace", workspaceDir });

    await openApp();

    const projectRow = page.getByTestId(`sidebar-project-${project.id}`);
    await projectRow.hover();
    await page.getByTestId(`sidebar-project-files-${project.id}`).click();

    await expect(page.getByTestId("files-page")).toBeVisible();
    await page.getByTestId("project-file-README.md").click();

    await expect(page.getByTestId("file-viewer")).toBeVisible();
    await expect(page.getByTestId("file-viewer-name")).toHaveText("README.md");
    await expect(page.getByText("E2E Workspace")).toBeVisible();

    await page.getByTestId("files-back").click();
    await expect(page.getByTestId("workspace-composer-input")).toBeVisible();
    await expect(page.getByTestId("workspace-project-pill")).toContainText("Files Workspace");
  });

  test("记忆页支持添加、编辑、搜索和删除", async ({ page, openApp, client, workspaceDir }) => {
    const project = await client.createProject({ name: "Memory Workspace", workspaceDir });
    const initialText = "Remember this exact preference";
    const editedText = "Remember this updated preference";

    await openApp();
    await page.getByTestId("sidebar-settings").click();
    await page.getByTestId("settings-nav-memory").click();
    await expect(page.getByTestId("memory-overlay")).toBeVisible();

    await page.getByTestId("memory-add-button").click();
    await expect(page.getByTestId("memory-add-dialog")).toBeVisible();
    await page.getByTestId("memory-add-scope").selectOption(`ws:${project.id}`);
    await page.getByTestId("memory-add-layer").selectOption("conventions");
    await page.getByTestId("memory-add-textarea").fill(initialText);
    await page.getByTestId("memory-add-submit").click();

    await expect
      .poll(
        async () =>
          (await client.listMemory({ scope: `ws:${project.id}` })).find(
            (item) => item.text === initialText,
          )?.id ?? null,
      )
      .not.toBeNull();
    const createdId =
      (await client.listMemory({ scope: `ws:${project.id}` })).find(
        (item) => item.text === initialText,
      )?.id ?? "";

    await expect(page.getByTestId(`memory-card-${createdId}`)).toContainText(initialText);
    await page.getByTestId(`memory-edit-${createdId}`).click();
    await page.getByTestId(`memory-edit-input-${createdId}`).fill(editedText);
    await page.getByTestId(`memory-save-${createdId}`).click();

    await expect
      .poll(
        async () =>
          (await client.listMemory({ scope: `ws:${project.id}` })).find(
            (item) => item.id === createdId,
          )?.text,
      )
      .toBe(editedText);

    await page.getByTestId("memory-search-input").fill("updated");
    await expect(page.getByTestId(`memory-card-${createdId}`)).toContainText(editedText);

    await page.getByTestId(`memory-card-${createdId}`).hover();
    await page.getByTestId(`memory-delete-${createdId}`).click();

    await expect
      .poll(async () =>
        (await client.listMemory({ scope: `ws:${project.id}` })).some(
          (item) => item.id === createdId,
        ),
      )
      .toBe(false);
    await expect(page.getByTestId(`memory-card-${createdId}`)).toHaveCount(0);
  });

  test("来源事实显示 provenance，并可确认提升为独立长期记忆", async ({ page, openApp }) => {
    let item = {
      id: "derived-memory",
      scope: "global",
      layer: "user-profile",
      text: "用户偏好先给结论",
      origin: "extracted" as const,
      state: "derived" as const,
      sourceThreadId: "source-thread-1234",
      sessionId: "source-thread-1234",
      updatedAt: new Date().toISOString(),
    };

    await page.route(/\/memory(?:\?.*)?$/, async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ items: [item] }),
        });
      } else {
        await route.continue();
      }
    });
    await page.route("**/memory/derived-memory/pin", async (route) => {
      const { sourceThreadId: _sourceThreadId, sessionId: _sessionId, ...rest } = item;
      item = {
        ...rest,
        state: "curated",
        updatedAt: new Date().toISOString(),
      } as typeof item;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(item),
      });
    });

    await openApp();
    await page.getByTestId("sidebar-settings").click();
    await page.getByTestId("settings-nav-memory").click();

    const card = page.getByTestId("memory-card-derived-memory");
    await expect(card).toContainText("自动提取");
    await expect(card).toContainText("来源 source-t");
    await expect(card).toContainText("随来源对话删除");
    await page.getByTestId("memory-promote-derived-memory").click();

    await expect(card).toContainText("自动提取 · 已确认");
    await expect(card).not.toContainText("来源 source-t");
    await expect(page.getByTestId("memory-promote-derived-memory")).toHaveCount(0);
    await expect(page.getByText("已确认并保留；删除来源对话不会再删除这条事实。")).toBeVisible();
  });
});
