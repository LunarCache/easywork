import { test, expect } from "./fixtures.js";
import type { Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

async function pasteImage(page: Page, testId: string): Promise<void> {
  await page.getByTestId(testId).focus();
  await page.evaluate((id) => {
    const target = document.querySelector(`[data-testid="${id}"]`);
    if (!target) throw new Error(`missing target: ${id}`);
    const data = new DataTransfer();
    data.items.add(new File(
      ['<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#2563eb"/></svg>'],
      "clipboard.svg",
      { type: "image/svg+xml" },
    ));
    target.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: data,
    }));
  }, testId);
}

test.describe("composer e2e", () => {
  test("聊天与工作区的 + 入口都能上传图片，并显示已附加图片", async ({ page, openApp, client, workspaceDir, sampleImagePath }) => {
    const project = await client.createProject({ name: "Upload Workspace", workspaceDir });

    await openApp();

    await expect(page.getByTestId("chat-composer-input")).toBeVisible();
    await page.getByTestId("chat-upload-button").click();
    await page.getByTestId("chat-upload-input").setInputFiles(sampleImagePath);
    await expect(page.getByTestId("chat-image-chip")).toContainText("1 张图");
    await page.getByTestId("chat-image-remove-0").click();
    await expect(page.getByTestId("chat-image-chip")).toHaveCount(0);

    await page.getByTestId(`sidebar-project-${project.id}`).click();
    await expect(page.getByTestId("workspace-composer-input")).toBeVisible();
    await page.getByTestId("workspace-upload-button").click();
    await page.getByTestId("workspace-upload-input").setInputFiles(sampleImagePath);
    await expect(page.getByTestId("workspace-image-chip")).toContainText("1 张图");
  });

  test("聊天与工作区 composer 支持直接粘贴图片", async ({ page, openApp, client, workspaceDir }) => {
    const project = await client.createProject({ name: "Paste Workspace", workspaceDir });

    await openApp();

    await pasteImage(page, "chat-composer-input");
    await expect(page.getByTestId("chat-image-chip")).toContainText("1 张图");
    await page.getByTestId("chat-image-remove-0").click();
    await expect(page.getByTestId("chat-image-chip")).toHaveCount(0);

    await page.getByTestId(`sidebar-project-${project.id}`).click();
    await expect(page.getByTestId("workspace-composer-input")).toBeVisible();
    await pasteImage(page, "workspace-composer-input");
    await expect(page.getByTestId("workspace-image-chip")).toContainText("1 张图");
  });

  test("聊天页 slash palette 可筛选并切换思考档位", async ({ page, openApp }) => {
    await openApp();

    const input = page.getByTestId("chat-composer-input");
    await expect(input).toBeVisible();

    await input.fill("/");
    await expect(page.getByTestId("slash-palette")).toBeVisible();
    await expect(page.getByTestId("slash-item-model")).toBeVisible();
    await expect(page.getByTestId("slash-item-skill")).toBeVisible();
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

  test("聊天页 slash palette 支持选择全局 skill", async ({ page, openApp, client }) => {
    await client.createSkillTemplate("review-flow");
    await openApp();

    const input = page.getByTestId("chat-composer-input");
    await expect(input).toBeVisible();

    await input.fill("/skill:review-flow");
    await expect(page.getByTestId("slash-palette")).toBeVisible();
    await expect(page.getByTestId("slash-item-skill:review-flow")).toBeVisible();

    await input.press("Enter");

    await expect(page.getByTestId("slash-palette")).toHaveCount(0);
    await expect(input).toHaveValue("/skill:review-flow ");
  });

  test("聊天页 slash palette 不展示已关闭的 skill", async ({ page, openApp, client }) => {
    await client.createSkillTemplate("disabled-flow");
    await openApp();

    const input = page.getByTestId("chat-composer-input");
    await expect(input).toBeVisible();

    await input.fill("/skill:disabled-flow");
    await expect(page.getByTestId("slash-item-skill:disabled-flow")).toBeVisible();

    await page.evaluate(() => {
      localStorage.setItem("ew.disabledSkills", JSON.stringify(["disabled-flow"]));
    });
    await input.fill("");
    await input.fill("/skill:disabled-flow");

    await expect(page.getByTestId("slash-item-skill:disabled-flow")).toHaveCount(0);
    await expect(page.getByTestId("slash-palette")).toHaveCount(0);
  });

  test("工作区 slash palette 会合并当前项目的 .agents/skills", async ({ page, openApp, client, workspaceDir }) => {
    const skillDir = path.join(workspaceDir, ".agents", "skills", "repo-flow");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      `---
name: repo-flow
description: project scoped workflow
---
# repo-flow`,
    );
    const project = await client.createProject({ name: "Skill Workspace", workspaceDir });

    await openApp();
    await page.getByTestId(`sidebar-project-${project.id}`).click();

    const input = page.getByTestId("workspace-composer-input");
    await expect(input).toBeVisible();

    await input.fill("/skill:repo-flow");
    await expect(page.getByTestId("slash-palette")).toBeVisible();
    await expect(page.getByTestId("slash-item-skill:repo-flow")).toBeVisible();
    await expect(page.getByTestId("slash-item-skill:repo-flow")).toContainText("工作区");

    await input.press("Enter");

    await expect(page.getByTestId("slash-palette")).toHaveCount(0);
    await expect(input).toHaveValue("/skill:repo-flow ");
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
