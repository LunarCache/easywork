import { test, expect } from "./fixtures.js";

test.describe("composer e2e", () => {
  test("聊天页 slash palette 可筛选并切换思考档位", async ({ page, openApp }) => {
    await openApp();

    const input = page.getByTestId("chat-composer-input");
    await expect(input).toBeVisible();

    await input.fill("/");
    await expect(page.getByTestId("slash-palette")).toBeVisible();
    await expect(page.getByTestId("slash-item-model")).toBeVisible();
    await expect(page.getByTestId("slash-item-think")).toBeVisible();
    await expect(page.getByTestId("slash-item-compact")).toBeVisible();

    await input.press("Escape");
    await expect(page.getByTestId("slash-palette")).toHaveCount(0);

    await input.fill("");
    await input.type("/th");
    await expect(page.getByTestId("slash-palette")).toBeVisible();
    await expect(page.getByTestId("slash-item-think")).toBeVisible();
    await expect(page.getByTestId("slash-item-model")).toHaveCount(0);

    await input.press("Enter");
    await expect(page.getByTestId("slash-item-off")).toBeVisible();

    await input.press("ArrowDown");
    await input.press("ArrowDown");
    await input.press("Enter");

    await expect(page.getByTestId("slash-palette")).toHaveCount(0);
    await expect(input).toHaveValue("");
    await expect(page.getByTestId("chat-think-pill")).toContainText("思考 中");
  });

  test("工作区 composer 支持 slash 思考档位和审批策略持久化", async ({ page, openApp, client, workspaceDir }) => {
    const project = await client.createProject({ name: "Composer Workspace", workspaceDir });

    await openApp();
    await page.getByTestId(`sidebar-project-${project.id}`).click();

    const input = page.getByTestId("workspace-composer-input");
    await expect(input).toBeVisible();

    await input.fill("/think h");
    await expect(page.getByTestId("slash-palette")).toBeVisible();
    await expect(page.getByTestId("slash-item-high")).toBeVisible();
    await input.press("Enter");

    await expect(page.getByTestId("workspace-think-pill")).toContainText("思考 高");
    await expect(input).toHaveValue("");

    await page.getByTestId("workspace-approval-pill").click();
    await expect(page.getByTestId("workspace-approval-menu")).toBeVisible();
    await page.getByTestId("workspace-approval-option-read-only").click();

    await expect(page.getByTestId("workspace-approval-menu")).toHaveCount(0);
    await expect(page.getByTestId("workspace-approval-pill")).toContainText("只读");
    await expect
      .poll(async () => (await client.listProjects()).find((item) => item.id === project.id)?.approvalMode)
      .toBe("read-only");

    await page.reload();
    await expect(page.getByTestId("sidebar-settings")).toBeVisible();
    await page.getByTestId(`sidebar-project-${project.id}`).click();
    await expect(page.getByTestId("workspace-composer-input")).toBeVisible();
    await expect(page.getByTestId("workspace-approval-pill")).toContainText("只读");
  });
});
