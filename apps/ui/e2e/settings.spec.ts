import { test, expect } from "./fixtures.js";

test.describe("settings e2e", () => {
  test("通用页可启用 HF 镜像并持久化", async ({ page, openApp }) => {
    await openApp();
    await page.getByTestId("sidebar-settings").click();

    const toggle = page.getByTestId("hf-mirror-toggle");
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");

    await page.reload();
    await page.getByTestId("sidebar-settings").click();
    await expect(page.getByTestId("hf-mirror-toggle")).toHaveAttribute("aria-checked", "true");
  });

  test("模型搜索失败时显示明确错误", async ({ page, openApp }) => {
    await page.route("**/models/search?*", async (route) => {
      await route.fulfill({ status: 502, body: "upstream unavailable" });
    });
    await openApp();
    await page.getByTestId("sidebar-settings").click();
    await page.getByTestId("settings-nav-models").click();
    await page.getByTitle("搜索并下载 HuggingFace GGUF 模型").click();
    await page.getByPlaceholder(/搜索 HuggingFace GGUF 模型/).fill("qwen");
    await page.getByRole("button", { name: "搜索", exact: true }).click();

    await expect(page.getByTestId("models-search-error")).toContainText("搜索失败");
    await expect(page.getByTestId("models-search-error")).toContainText("HF 镜像");
  });

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

  test("自定义模型通过连接方式复用混合协议端点并保留目录能力", async ({ page, openApp }) => {
    let savedProvider: { modelConfigs?: Array<{ api?: string; baseUrl?: string }> } | undefined;
    await page.route("**/providers", async (route) => {
      if (route.request().method() === "POST") {
        savedProvider = route.request().postDataJSON() as typeof savedProvider;
        return route.fulfill({ json: { ok: true } });
      }
      if (route.request().method() !== "GET") return route.continue();
      await route.fulfill({ json: { providers: [] } });
    });
    await page.route("**/providers/catalog", async (route) => {
      await route.fulfill({
        json: {
          providers: [{
            id: "deepseek",
            label: "DeepSeek",
            apiFamilies: ["openai-completions"],
            apiOptions: [{ id: "openai-completions", label: "OpenAI Chat Completions" }],
            modelCount: 1,
            sampleModels: ["deepseek-v4-pro"],
            models: [{
              id: "deepseek-v4-pro",
              name: "DeepSeek V4 Pro",
              api: "openai-completions",
              reasoning: true,
              contextWindow: 1_000_000,
              inputModalities: ["text", "image"],
            }],
          }],
          apiFamilies: [
            { id: "openai-completions", label: "OpenAI Chat Completions" },
            { id: "anthropic-messages", label: "Anthropic Messages" },
          ],
        },
      });
    });

    await openApp();
    await page.getByTestId("sidebar-settings").click();
    await page.getByTestId("settings-nav-models").click();
    await page.getByTestId("models-tab-cloud").click();
    await page.getByRole("button", { name: "添加 Provider" }).click();
    await page.getByTitle("自定义兼容端点").click();

    await page.getByPlaceholder("openrouter").fill("mixed-provider");
    await page.getByPlaceholder("https://.../v1").fill("https://mixed.example/v1");

    await expect(page.getByTestId("provider-connection-default").locator(".provider-connection-preview"))
      .toContainText("https://mixed.example/v1/chat/completions");
    await page.getByRole("button", { name: "添加连接方式" }).click();
    const override = page.getByTestId("provider-connection-override");
    await override.getByTitle("连接 2 API 协议").selectOption("anthropic-messages");
    await expect(override.locator(".provider-connection-preview"))
      .toContainText("https://mixed.example/v1/messages");

    const entry = page.locator(".provider-model-entry").first();
    const row = entry.locator(".provider-model-row");
    await row.locator('input[placeholder="model-id"]').fill("deepseek-v4-pro");
    const connectionSelect = row.getByTitle("模型连接方式");
    const overrideId = await connectionSelect.locator("option").nth(1).getAttribute("value");
    await row.getByLabel("选择模型 deepseek-v4-pro").check();
    await page.getByLabel("批量设置连接方式").selectOption(overrideId ?? "");
    await expect(connectionSelect).toHaveValue(overrideId ?? "");

    await expect(row.locator('input[type="number"]')).toHaveValue("1000000");
    await row.getByTitle("模型高级设置").click();
    const advanced = entry.locator(".provider-model-advanced");
    await expect(advanced.getByText("支持视觉输入")).toBeVisible();
    await expect(advanced.locator('input[type="checkbox"]')).toBeChecked();
    await expect(advanced.locator(".provider-model-template-trigger")).toContainText("自动匹配");

    await page.setViewportSize({ width: 900, height: 800 });
    for (const selector of [".provider-form-panel", ".provider-connections", ".provider-model-table"]) {
      const fitsWithoutHorizontalScroll = await page.locator(selector).evaluate((element) =>
        element.scrollWidth <= element.clientWidth);
      expect(fitsWithoutHorizontalScroll, `${selector} should fit at 900px`).toBe(true);
    }
    await expect(page.locator(".provider-model-bulkbar label")).toHaveCSS("white-space", "nowrap");

    await page.getByRole("button", { name: "添加 Provider" }).click();
    await expect.poll(() => savedProvider?.modelConfigs?.[0]?.api).toBe("anthropic-messages");
    expect(savedProvider?.modelConfigs?.[0]?.baseUrl).toBeUndefined();
  });

  test("编辑自定义模型商时保留模型连接字段的独立继承", async ({ page, openApp }) => {
    let savedProvider: {
      modelConfigs?: Array<{ id: string; api?: string; baseUrl?: string }>;
      connections?: Array<{ id: string; api?: string; baseUrl?: string }>;
    } | undefined;
    let provider = {
      id: "partial-provider",
      kind: "openai-compatible",
      api: "openai-completions",
      baseUrl: "https://default.example/v1",
      models: ["api-only", "url-only"],
      modelConfigs: [
        {
          id: "api-only",
          api: "anthropic-messages",
          inputModalities: ["text"],
          contextWindow: 32768,
          compatibilityMode: "generic",
        },
        {
          id: "url-only",
          baseUrl: "https://special.example/v1",
          inputModalities: ["text"],
          contextWindow: 32768,
          compatibilityMode: "generic",
        },
      ],
    };
    await page.route("**/providers", async (route) => {
      if (route.request().method() === "POST") {
        savedProvider = route.request().postDataJSON() as typeof savedProvider;
        provider = { ...provider, ...savedProvider };
        return route.fulfill({ json: { ok: true } });
      }
      if (route.request().method() !== "GET") return route.continue();
      await route.fulfill({ json: { providers: [provider] } });
    });

    await openApp();
    await page.getByTestId("sidebar-settings").click();
    await page.getByTestId("settings-nav-models").click();
    await page.getByTestId("models-tab-cloud").click();
    await page.locator(".provider-card-compact").filter({ hasText: "partial-provider" }).getByTitle("编辑").click();
    await page.getByRole("button", { name: "添加连接方式" }).click();
    const addedConnection = page.getByTestId("provider-connection-override").last();
    await addedConnection.getByTitle("连接 4 API 协议").selectOption("openai-responses");
    await addedConnection.getByTitle("连接 4 Base URL").fill("https://responses.example/v1");
    await page.getByRole("button", { name: "保存配置" }).click();

    await expect.poll(() => savedProvider?.modelConfigs?.length).toBe(2);
    expect(savedProvider?.connections).toEqual(expect.arrayContaining([
      expect.objectContaining({ api: "openai-responses", baseUrl: "https://responses.example/v1" }),
    ]));
    const apiOnly = savedProvider?.modelConfigs?.find((model) => model.id === "api-only");
    const urlOnly = savedProvider?.modelConfigs?.find((model) => model.id === "url-only");
    expect(apiOnly).toMatchObject({ api: "anthropic-messages" });
    expect(apiOnly).not.toHaveProperty("baseUrl");
    expect(urlOnly).toMatchObject({ baseUrl: "https://special.example/v1" });
    expect(urlOnly).not.toHaveProperty("api");

    await page.locator(".provider-card-compact").filter({ hasText: "partial-provider" }).getByTitle("编辑").click();
    const restoredConnection = page.getByTestId("provider-connection-override").last();
    await expect(restoredConnection.getByTitle("连接 4 API 协议")).toHaveValue("openai-responses");
    await expect(restoredConnection.getByTitle("连接 4 Base URL")).toHaveValue("https://responses.example/v1");
  });

  test("渠道页可打开并记住上次分区", async ({ page, openApp }) => {
    await openApp();

    await page.getByTestId("sidebar-settings").click();
    await page.getByTestId("settings-nav-channels").click();
    await expect(page.getByTestId("settings-title")).toHaveText("渠道");
    await expect(page.getByTestId("channels-page")).toBeVisible();
    await expect(page.getByTestId("channels-list")).toBeVisible();
    await expect(page.getByText("还没有渠道")).toBeVisible();

    await page.getByTestId("settings-back").click();
    await page.getByTestId("sidebar-settings").click();
    await expect(page.getByTestId("settings-title")).toHaveText("渠道");
  });

  test("记忆页主操作按钮可见", async ({ page, openApp, client, workspaceDir }) => {
    const project = await client.createProject({ name: "PW Project", workspaceDir });
    await client.writeMemory({ scope: `ws:${project.id}`, layer: "conventions", text: "Use playwright for UI e2e." });

    await openApp();
    await page.getByTestId("sidebar-settings").click();

    await page.getByTestId("settings-nav-memory").click();
    await expect(page.getByTestId("memory-overlay")).toBeVisible();
    await expect(page.getByTestId("memory-add-button")).toBeVisible();
    await expect(page.getByText("Use playwright for UI e2e.")).toBeVisible();
  });
});
