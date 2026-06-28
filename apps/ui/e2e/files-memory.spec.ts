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
      .poll(async () => (await client.listMemory({ scope: `ws:${project.id}` })).find((item) => item.text === initialText)?.id ?? null)
      .not.toBeNull();
    const createdId =
      (await client.listMemory({ scope: `ws:${project.id}` })).find((item) => item.text === initialText)?.id ?? "";

    await expect(page.getByTestId(`memory-card-${createdId}`)).toContainText(initialText);
    await page.getByTestId(`memory-edit-${createdId}`).click();
    await page.getByTestId(`memory-edit-input-${createdId}`).fill(editedText);
    await page.getByTestId(`memory-save-${createdId}`).click();

    await expect
      .poll(async () => (await client.listMemory({ scope: `ws:${project.id}` })).find((item) => item.id === createdId)?.text)
      .toBe(editedText);

    await page.getByTestId("memory-search-input").fill("updated");
    await expect(page.getByTestId(`memory-card-${createdId}`)).toContainText(editedText);

    await page.getByTestId(`memory-card-${createdId}`).hover();
    await page.getByTestId(`memory-delete-${createdId}`).click();

    await expect
      .poll(async () => (await client.listMemory({ scope: `ws:${project.id}` })).some((item) => item.id === createdId))
      .toBe(false);
    await expect(page.getByTestId(`memory-card-${createdId}`)).toHaveCount(0);
  });
});
