import { test, expect } from "./fixtures.js";
import type { Locator, Page } from "@playwright/test";
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

async function expectBorderless(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  await expect
    .poll(() => locator.evaluate((element) => {
      const style = getComputedStyle(element);
      return [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth];
    }))
    .toEqual(["0px", "0px", "0px", "0px"]);
}

test.describe("composer e2e", () => {
  test("聊天与工作区空状态展示 Ewo 形象", async ({ page, openApp, client, workspaceDir }) => {
    const project = await client.createProject({ name: "Ewo Workspace", workspaceDir });

    await openApp();
    await expect(page.getByTestId("chat-mascot")).toBeVisible();

    await page.getByTestId(`sidebar-project-${project.id}`).click();
    await expect(page.getByTestId("workspace-mascot")).toBeVisible();
  });

  test("模型与思考强度通过同一个 composer 组件调整", async ({ page, openApp, client, info, workspaceDir }) => {
    const project = await client.createProject({ name: "Unified Model Controls", workspaceDir });
    await page.route(`${info.baseUrl}/models`, async (route) => {
      await route.fulfill({
        json: {
          routed: ["provider:custom:deepseek-v4-pro"],
          modelSources: [{
            id: "provider:custom:deepseek-v4-pro",
            kind: "provider",
            label: "Custom",
            providerId: "custom",
            providerKind: "openai-compatible",
            modelId: "deepseek-v4-pro",
            reasoning: true,
          }],
          context: { "provider:custom:deepseek-v4-pro": 1_000_000 },
          engines: [],
        },
      });
    });

    await openApp();

    const chatControl = page.getByTestId("chat-model-thinking-trigger");
    await expect(chatControl).toContainText("deepseek-v4-pro");
    await expect(chatControl).toContainText("中");
    await expect(page.getByTestId("chat-think-pill")).toHaveCount(0);

    await chatControl.click();
    const menu = page.getByTestId("chat-model-thinking-menu");
    const modelRow = page.getByTestId("chat-model-thinking-model-row");
    await expect(menu).toBeVisible();
    await expect.poll(async () => (await menu.boundingBox())?.width).toBeLessThanOrEqual(250);
    await expect.poll(async () => (await modelRow.boundingBox())?.height).toBeLessThanOrEqual(36);
    await expect.poll(() => modelRow.locator(".model-thinking-row-label").evaluate((element) => getComputedStyle(element).fontSize)).toBe("12.5px");
    await expect(modelRow).toContainText("模型");
    await expect(page.getByTestId("chat-model-thinking-level-row")).toContainText("推理强度");

    await page.getByTestId("chat-model-thinking-level-row").click();
    await page.getByTestId("chat-model-thinking-level-high").click();
    await expect(chatControl).toContainText("高");

    await chatControl.click();
    await page.getByTestId("chat-model-thinking-model-row").click();
    const currentModelOption = page.getByTestId("chat-model-thinking-model-provider:custom:deepseek-v4-pro");
    await expect(currentModelOption).toBeVisible();
    await currentModelOption.click();

    await page.getByTestId(`sidebar-project-${project.id}`).click();
    const workspaceControl = page.getByTestId("workspace-model-thinking-trigger");
    await expect(workspaceControl).toContainText("deepseek-v4-pro");
    await expect(workspaceControl).toContainText("高");
    await expect(page.getByTestId("workspace-think-pill")).toHaveCount(0);
  });

  test("聊天与工作区 composer 内的控件均为无边框", async ({ page, openApp, client, info, workspaceDir, sampleImagePath }) => {
    const project = await client.createProject({ name: "Borderless Workspace", workspaceDir });
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

    await openApp();

    const chatBox = page.getByTestId("chat-composer-input").locator("..");
    const chatModelButton = chatBox.locator(".model-sel-btn.strip");
    await expectBorderless(chatModelButton);
    await expect.poll(async () => (await chatModelButton.boundingBox())?.height).toBeLessThanOrEqual(28);
    await expect.poll(() => chatModelButton.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
    await chatModelButton.hover();
    await expect.poll(() => chatModelButton.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgb(238, 242, 243)");
    await page.getByTestId("chat-upload-input").setInputFiles(sampleImagePath);
    await expectBorderless(page.getByTestId("chat-image-chip"));
    await expectBorderless(page.getByTestId("chat-image-strip").locator("img"));

    await page.getByTestId(`sidebar-project-${project.id}`).click();
    const workspaceBox = page.getByTestId("workspace-composer-input").locator("..");
    const workspaceModelButton = workspaceBox.locator(".model-sel-btn.strip");
    await expectBorderless(page.getByTestId("workspace-project-pill"));
    await expectBorderless(page.getByTestId("workspace-approval-pill"));
    await expectBorderless(workspaceModelButton);
    await expect.poll(() => workspaceModelButton.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
    await page.getByTestId("workspace-upload-input").setInputFiles(sampleImagePath);
    await expectBorderless(page.getByTestId("workspace-image-chip"));
    await expectBorderless(page.getByTestId("workspace-image-strip").locator("img"));
  });

  test("聊天与工作区的上下文圆环隐藏数字，并在悬停时显示内容分布", async ({ page, openApp, client, info, workspaceDir }) => {
    const project = await client.createProject({ name: "Context Usage Workspace", workspaceDir });
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
    await page.route(`${info.baseUrl}/threads/*/usage`, async (route) => {
      await route.fulfill({
        json: { usage: { promptTokens: 8_192, completionTokens: 512, totalTokens: 8_704 } },
      });
    });

    await openApp();

    const chatUsage = page.getByTestId("chat-context-usage");
    await expect(chatUsage).toBeVisible();
    await expect(chatUsage).not.toContainText("25%");
    await chatUsage.hover();
    await expect(page.getByTestId("chat-context-usage-tooltip")).toContainText("上下文已用 26.6% · 8,704/32,768 tokens");
    await expect(page.getByTestId("chat-context-usage-unclassified")).toHaveText("其余输入（系统等）~8,19225%");
    await expect(page.getByTestId("chat-context-usage-output")).toHaveText("本轮输出5121.6%");
    await expect(page.getByTestId("chat-context-usage-available")).toHaveText("可用空间24,06473.4%");
    await expect(page.getByTestId("chat-context-usage-tooltip")).toContainText("内容分类为估算");
    await expect(page.getByTestId("chat-context-usage-tooltip")).toBeVisible();

    await page.getByTestId(`sidebar-project-${project.id}`).click();
    const workspaceUsage = page.getByTestId("workspace-context-usage");
    await expect(workspaceUsage).toBeVisible();
    await expect(workspaceUsage).not.toContainText("25%");
    await workspaceUsage.hover();
    await expect(page.getByTestId("workspace-context-usage-tooltip")).toContainText("上下文已用 26.6% · 8,704/32,768 tokens");
    await expect(page.getByTestId("workspace-context-usage-unclassified")).toHaveText("其余输入（系统等）~8,19225%");
    await expect(page.getByTestId("workspace-context-usage-output")).toHaveText("本轮输出5121.6%");
    await expect(page.getByTestId("workspace-context-usage-available")).toHaveText("可用空间24,06473.4%");
    await expect(page.getByTestId("workspace-context-usage-tooltip")).toContainText("内容分类为估算");
    await expect(page.getByTestId("workspace-context-usage-tooltip")).toBeVisible();
  });

  test("普通对话在对应助手轮次显示最终交付文件并可打开预览", async ({ page, openApp, info }) => {
    await page.route(`${info.baseUrl}/models`, async (route) => {
      await route.fulfill({
        json: {
          routed: ["test-model"],
          modelSources: [{ id: "test-model", kind: "engine", label: "Test", modelId: "test-model" }],
          context: { "test-model": 32768 },
          engines: [],
        },
      });
    });
    await page.route(`${info.baseUrl}/chat/*/files?*`, async (route) => {
      // 列表默认只取四层；交付路径更深时也应能按路径直接预览。
      await route.fulfill({ json: { entries: [] } });
    });
    await page.route(`${info.baseUrl}/files/meta?*`, async (route) => {
      await route.fulfill({
        json: { name: "reports/summary.md", mime: "text/markdown", kind: "markdown", size: 2048, text: "# Summary" },
      });
    });
    await page.route(`${info.baseUrl}/agent/run`, async (route) => {
      const artifacts = [{ path: "exports/2026/reports/final/summary.md", kind: "created", size: 2048 }];
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: [
          `data: ${JSON.stringify({ type: "text", text: "报告已生成。" })}\n\n`,
          `data: ${JSON.stringify({ type: "final", message: { role: "assistant", content: "报告已生成。" } })}\n\n`,
          `data: ${JSON.stringify({ type: "artifacts", artifacts })}\n\n`,
          "data: [DONE]\n\n",
        ].join(""),
      });
    });

    await openApp();
    await page.getByTestId("chat-composer-input").fill("生成报告");
    await page.getByTestId("chat-composer-input").press("Enter");

    const card = page.locator('[data-testid^="turn-artifacts-"]');
    await expect(card).toContainText("本轮交付");
    await expect(card).toContainText("summary.md");
    await expect(card).toContainText("新建");
    await card.getByRole("button", { name: /summary\.md/ }).click();
    await expect(page.locator(".side-dock .sd-top")).toHaveCount(0);
    await expect(page.locator(".ad-titlebar").getByTestId("side-dock-tab-files")).toBeVisible();
    await expect(page.getByTestId("side-dock-tab-files")).toHaveClass(/on/);
    await expect(page.getByTestId("file-viewer-name")).toHaveText("summary.md");
  });

  test("Markdown 交付文件在普通侧栏使用主从导航，放大后使用双栏且只有一套预览工具栏", async ({ page, openApp, info }) => {
    const absolutePath = "/Users/test/.easywork/workspace/chats/thread/shanghai-weather.md";
    let listedFiles = [{ path: "shanghai-weather.md", type: "file", size: 1024 }];
    await page.route(`${info.baseUrl}/models`, async (route) => {
      await route.fulfill({
        json: {
          routed: ["test-model"],
          modelSources: [{ id: "test-model", kind: "engine", label: "Test", modelId: "test-model" }],
          context: { "test-model": 32768 },
          engines: [],
        },
      });
    });
    await page.route(`${info.baseUrl}/chat/*/files?*`, async (route) => {
      await route.fulfill({ json: { entries: listedFiles } });
    });
    await page.route(`${info.baseUrl}/files/meta?*`, async (route) => {
      await route.fulfill({
        json: { name: "shanghai-weather.md", mime: "text/markdown", kind: "markdown", size: 1024, text: "# 上海天气" },
      });
    });
    await page.route(`${info.baseUrl}/agent/run`, async (route) => {
      const call = { id: "write-1", name: "write", arguments: JSON.stringify({ path: absolutePath, content: "# 上海天气" }) };
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: [
          `data: ${JSON.stringify({ type: "tool-start", call })}\n\n`,
          `data: ${JSON.stringify({ type: "tool-end", call, result: { content: "ok", display: { kind: "diff", path: absolutePath, before: null, after: "# 上海天气" } } })}\n\n`,
          `data: ${JSON.stringify({ type: "text", text: "页面已生成。" })}\n\n`,
          `data: ${JSON.stringify({ type: "final", message: { role: "assistant", content: "页面已生成。" } })}\n\n`,
          `data: ${JSON.stringify({ type: "artifacts", artifacts: [{ path: "shanghai-weather.md", kind: "created", size: 1024 }] })}\n\n`,
          "data: [DONE]\n\n",
        ].join(""),
      });
    });

    await openApp();
    await page.getByTestId("chat-composer-input").fill("生成上海天气页面");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.locator(".cv-changes-row")).toHaveCount(1);
    await page.locator(".cv-changes-row").evaluate((element: HTMLElement) => element.click());

    await expect(page.getByTestId("side-dock-tab-files")).toHaveClass(/on/);
    await expect(page.getByTestId("side-dock-tab-terminal")).toHaveCount(0);
    await expect(page.getByTestId("side-dock-tab-preview")).toHaveCount(0);
    await expect(page.getByTestId("side-dock-add-view")).toBeVisible();
    await expect(page.locator(".side-dock .af-file")).toHaveCount(0);
    await expect(page.getByTestId("file-viewer-name")).toHaveText("shanghai-weather.md");
    await expect(page.getByTestId("file-viewer-name")).toHaveCount(1);
    await expect(page.getByTitle("返回文件列表")).toBeVisible();

    const previewFillRatio = async () => {
      const available = await page.locator(".side-dock .sd-body").boundingBox();
      const preview = await page.locator(".side-dock .files-detail").boundingBox();
      return available && preview ? preview.height / available.height : 0;
    };
    await expect.poll(previewFillRatio).toBeGreaterThan(0.9);

    await page.getByTitle("返回文件列表").click();
    await expect(page.locator(".side-dock .af-file")).toHaveCount(1);
    await expect(page.getByTestId("file-viewer")).toHaveCount(0);
    await page.locator(".side-dock .af-file").click();
    await expect(page.getByTestId("file-viewer-name")).toHaveText("shanghai-weather.md");

    await page.getByTitle("放大到窗口").click();
    await expect(page.locator(".side-dock")).toHaveClass(/max/);
    await expect(page.locator(".side-dock .files-split")).toBeVisible();
    await expect(page.locator(".side-dock .af-file")).toHaveCount(1);
    await expect(page.getByTestId("file-viewer-name")).toHaveCount(1);
    await expect.poll(previewFillRatio).toBeGreaterThan(0.9);

    // 文件行超过导航栏高度时，左侧列表独立滚动，右侧预览不受影响。
    listedFiles = [
      { path: "shanghai-weather.md", type: "file", size: 1024 },
      ...Array.from({ length: 18 }, (_, index) => ({ path: `notes-${index + 1}.txt`, type: "file", size: 128 })),
    ];
    await page.locator(".side-dock").getByTitle("刷新").click();
    await expect(page.locator(".side-dock .af-file")).toHaveCount(19);
    const scrollMetrics = await page.locator(".side-dock .af-scroll").evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }));
    expect(scrollMetrics.scrollHeight).toBeGreaterThan(scrollMetrics.clientHeight);
    await expect(page.getByTestId("file-viewer-name")).toHaveText("shanghai-weather.md");

    await page.getByTitle("还原").click();
    await expect(page.locator(".side-dock .af-file")).toHaveCount(0);
    await expect(page.getByTestId("file-viewer-name")).toHaveCount(1);
  });

  test("HTML 交付文件直接在浏览器标签打开，不进入 FileViewer", async ({ page, openApp, info }) => {
    const absolutePath = "/Users/test/.easywork/workspace/chats/thread/shanghai-weather.html";
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
    await page.route(`${info.baseUrl}/chat/*/files?*`, async (route) => {
      await route.fulfill({ json: { entries: [{ path: "shanghai-weather.html", type: "file", size: 1024 }] } });
    });
    await page.route(`${info.baseUrl}/files/meta?*`, async (route) => {
      await route.fulfill({
        json: { name: "shanghai-weather.html", mime: "text/html", kind: "html", size: 1024, text: "<h1>上海天气</h1>" },
      });
    });
    await page.route(`${info.baseUrl}/agent/run`, async (route) => {
      const call = { id: "write-html", name: "write", arguments: JSON.stringify({ path: absolutePath, content: "<h1>上海天气</h1>" }) };
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: [
          `data: ${JSON.stringify({ type: "tool-start", call })}\n\n`,
          `data: ${JSON.stringify({ type: "tool-end", call, result: { content: "ok", display: { kind: "diff", path: absolutePath, before: null, after: "<h1>上海天气</h1>" } } })}\n\n`,
          `data: ${JSON.stringify({ type: "text", text: "页面已生成。" })}\n\n`,
          `data: ${JSON.stringify({ type: "final", message: { role: "assistant", content: "页面已生成。" } })}\n\n`,
          `data: ${JSON.stringify({ type: "artifacts", artifacts: [{ path: "shanghai-weather.html", kind: "created", size: 1024 }] })}\n\n`,
          "data: [DONE]\n\n",
        ].join(""),
      });
    });

    await openApp();
    await page.getByTestId("chat-composer-input").fill("生成上海天气页面");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await page.locator(".cv-changes-row").evaluate((element: HTMLElement) => element.click());

    await expect(page.getByTestId("side-dock-tab-preview")).toHaveClass(/on/);
    await expect(page.getByRole("textbox", { name: "浏览器地址" })).toHaveValue("shanghai-weather.html");
    await expect(page.locator(".side-dock .wpv-frame")).toHaveAttribute("srcdoc", "<h1>上海天气</h1>");
    await expect(page.getByTestId("file-viewer")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "预览", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "源码", exact: true })).toHaveCount(0);

    await page.getByTitle("关闭浏览器标签").click();
    await expect(page.getByTestId("side-dock-tab-preview")).toHaveCount(0);
    await expect(page.getByTestId("side-dock-empty")).toBeVisible();
    await page.getByTestId("side-dock-add-view").click();
    await page.getByTestId("side-dock-view-menu").getByRole("menuitem", { name: "文件" }).click();
    await expect(page.getByTestId("side-dock-tab-files")).toHaveClass(/on/);
    await page.locator(".side-dock .af-file").click();
    await expect(page.getByTestId("side-dock-tab-preview")).toHaveClass(/on/);
    await expect(page.locator(".side-dock .wpv-frame")).toHaveAttribute("srcdoc", "<h1>上海天气</h1>");
  });

  test("聊天页默认启用联网工具且不显示联网开关", async ({ page, openApp, info }) => {
    let requestBody: { excludeTools?: string[] } | null = null;
    await page.route(`${info.baseUrl}/models`, async (route) => {
      await route.fulfill({
        json: {
          routed: ["test-model"],
          modelSources: [{ id: "test-model", kind: "engine", label: "Test", modelId: "test-model" }],
          context: { "test-model": 32768 },
          engines: [],
        },
      });
    });
    await page.route(`${info.baseUrl}/agent/run`, async (route) => {
      requestBody = route.request().postDataJSON() as { excludeTools?: string[] };
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: `data: ${JSON.stringify({ type: "final", message: { role: "assistant", content: "ok" } })}\n\n`,
      });
    });

    await openApp();
    await expect(page.getByTestId("chat-web-pill")).toHaveCount(0);
    await expect(page.getByTestId("chat-model-thinking-trigger")).toContainText("test-model");

    const input = page.getByTestId("chat-composer-input");
    await input.fill("帮我联网搜索");
    await page.getByRole("button", { name: "发送", exact: true }).click();

    await expect.poll(() => requestBody).not.toBeNull();
    expect(requestBody?.excludeTools).toBeUndefined();
  });

  test("推理模型在没有个人偏好时继承默认思考档位，并记住显式关闭", async ({ page, openApp, info }) => {
    await page.route(`${info.baseUrl}/models`, async (route) => {
      await route.fulfill({
        json: {
          routed: ["provider:custom:deepseek-v4-pro"],
          modelSources: [{
            id: "provider:custom:deepseek-v4-pro",
            kind: "provider",
            label: "Custom",
            providerId: "custom",
            providerKind: "openai-compatible",
            modelId: "deepseek-v4-pro",
            reasoning: true,
          }],
          context: { "provider:custom:deepseek-v4-pro": 1_000_000 },
          engines: [],
        },
      });
    });

    await openApp();
    const modelThinking = page.getByTestId("chat-model-thinking-trigger");
    await expect(modelThinking).toContainText("中");

    await modelThinking.click();
    await page.getByTestId("chat-model-thinking-level-row").click();
    await page.getByTestId("chat-model-thinking-level-off").click();
    await expect(modelThinking).toContainText("关");

    await page.reload();
    await expect(page.getByTestId("chat-model-thinking-trigger")).toContainText("关");
  });

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
    await expect(page.getByTestId("chat-model-thinking-trigger")).toContainText("中");
  });

  test("普通对话通过 /learn 准备当前对话的 Skill 学习提示", async ({ page, openApp, client, info, workspaceDir }) => {
    const project = await client.createProject({ name: "Learn Command Workspace", workspaceDir });
    let preparedThreadId = "";
    await page.route(`${info.baseUrl}/skill-learning/prepare`, async (route) => {
      const payload = route.request().postDataJSON() as { kind?: string; threadId?: string };
      preparedThreadId = payload.threadId ?? "";
      expect(payload.kind).toBe("conversation");
      await route.fulfill({ json: { prompt: "请从当前对话提炼一个可复用 Skill" } });
    });

    await openApp();

    await expect(page.getByTestId("chat-learn-skill-button")).toHaveCount(0);
    const threadId = await page.getByTestId("chat-root").getAttribute("data-thread-id");
    const input = page.getByTestId("chat-composer-input");
    await input.fill("/learn");
    await expect(page.getByTestId("slash-item-learn")).toBeVisible();
    await input.press("Enter");

    await expect(input).toHaveValue("请从当前对话提炼一个可复用 Skill");
    await expect(page.getByText("已生成 Skill 学习提示，请检查后发送")).toBeVisible();
    expect(preparedThreadId).toBe(threadId);

    await page.getByTestId(`sidebar-project-${project.id}`).click();
    const workspaceInput = page.getByTestId("workspace-composer-input");
    await workspaceInput.fill("/learn");
    await expect(page.getByTestId("slash-item-learn")).toHaveCount(0);
    await expect(page.getByTestId("slash-palette")).toHaveCount(0);
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

    await expect(page.getByTestId("workspace-model-thinking-trigger")).toContainText("高");
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
