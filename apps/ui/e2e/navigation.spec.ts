import { test, expect } from "./fixtures.js";

async function installFakeTerminalRuntime(page: import("@playwright/test").Page, config: { baseUrl: string; token: string }) {
  await page.addInitScript(({ baseUrl, token }) => {
    type FakeChannel = { onmessage?: (event: unknown) => void };
    type FakeSession = { sessionId: string; scope: string; title: string; cwd: string };
    const sessions: FakeSession[] = JSON.parse(sessionStorage.getItem("fake-terminal-sessions") ?? "[]") as FakeSession[];
    const attachments = new Map<string, FakeChannel>();
    const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
    const state = { busy: false };
    let nextSession = sessions.reduce((max, session) => {
      const index = Number(session.sessionId.replace(/^term-/, ""));
      return Number.isFinite(index) ? Math.max(max, index) : max;
    }, 0) + 1;
    let nextAttachment = 1;

    class Channel {
      onmessage?: (event: unknown) => void;
    }

    const output = (sessionId: string, text: string) => {
      const bytes = new TextEncoder().encode(text);
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      const data = btoa(binary);
      for (const [key, channel] of attachments) {
        if (key.startsWith(`${sessionId}:`)) channel.onmessage?.({ event: "output", data: { data } });
      }
    };
    const persistSessions = () => sessionStorage.setItem("fake-terminal-sessions", JSON.stringify(sessions));

    Object.defineProperty(window, "__fakeTerminal", {
      configurable: true,
      value: { sessions, calls, state },
    });
    Object.defineProperty(window, "__TAURI__", {
      configurable: true,
      value: {
        core: {
          Channel,
          invoke: async (command: string, rawArgs?: unknown) => {
            const args = (rawArgs ?? {}) as Record<string, unknown>;
            if (command === "get_config") return { baseUrl, token };
            calls.push({ command, args });
            if (command === "terminal_list") return sessions.filter((session) => session.scope === args.scope);
            if (command === "terminal_create") {
              const session: FakeSession = {
                sessionId: `term-${nextSession}`,
                scope: String(args.scope),
                title: `终端 ${nextSession}`,
                cwd: String(args.cwd),
              };
              nextSession += 1;
              sessions.push(session);
              persistSessions();
              return session;
            }
            if (command === "terminal_attach") {
              const attachmentId = `attachment-${nextAttachment++}`;
              attachments.set(`${String(args.sessionId)}:${attachmentId}`, args.channel as FakeChannel);
              queueMicrotask(() => output(String(args.sessionId), `ready:${String(args.sessionId)}\r\n`));
              return attachmentId;
            }
            if (command === "terminal_detach") {
              attachments.delete(`${String(args.sessionId)}:${String(args.attachmentId)}`);
              return null;
            }
            if (command === "terminal_write") {
              output(String(args.sessionId), String(args.data));
              return null;
            }
            if (command === "terminal_resize") return null;
            if (command === "terminal_close") {
              if (state.busy && !args.force) return "confirmation_required";
              const index = sessions.findIndex((session) => session.sessionId === args.sessionId);
              if (index >= 0) sessions.splice(index, 1);
              persistSessions();
              return "closed";
            }
            throw new Error(`unexpected command: ${command}`);
          },
        },
      },
    });
  }, config);
}

test.describe("navigation e2e", () => {
  test("浏览器运行时不暴露 Desktop PTY 终端", async ({ page, openApp }) => {
    await openApp();
    await expect(page.getByTestId("terminal-toggle")).toHaveCount(0);
  });

  test("Desktop PTY 在对话区底部独立打开，支持多会话、隐藏恢复和关闭", async ({ page, openApp, info }) => {
    await installFakeTerminalRuntime(page, info);
    await openApp();
    await page.getByTestId("home-new-workspace").click();
    await expect(page.getByTestId("workspace-composer-input")).toBeVisible();
    await page.getByTestId("terminal-toggle").click();

    await expect(page.getByTestId("terminal-panel")).toBeVisible();
    await page.getByTestId("terminal-panel-new").click();

    await expect(page.locator(".terminal-panel-tab-shell")).toHaveCount(2);
    await expect(page.locator(".terminal-panel .xterm")).toBeVisible();
    await expect(page.locator(".terminal-panel .xterm-screen")).toContainText("ready:term-2");
    await page.locator(".terminal-panel .xterm-helper-textarea").focus();
    await page.keyboard.type("echo hello");
    await page.keyboard.press("Enter");
    await expect(page.locator(".terminal-panel .xterm-screen")).toContainText("echo hello");
    await expect.poll(() => page.evaluate(() => {
      const calls = (window as unknown as { __fakeTerminal: { calls: Array<{ command: string }> } }).__fakeTerminal.calls;
      return {
        wrote: calls.some((call) => call.command === "terminal_write"),
        resized: calls.some((call) => call.command === "terminal_resize"),
      };
    })).toEqual({ wrote: true, resized: true });

    await page.getByTestId("terminal-toggle").click();
    await expect(page.getByTestId("terminal-panel")).not.toBeVisible();
    await page.getByTestId("terminal-toggle").click();
    await expect(page.locator(".terminal-panel-tab-shell")).toHaveCount(2);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __fakeTerminal: { sessions: unknown[] } }).__fakeTerminal.sessions.length)).toBe(2);

    await page.getByTitle("打开工作台").click();
    await page.getByTestId("side-dock-add-view").click();
    await expect(page.getByTestId("side-dock-view-menu").getByRole("menuitem", { name: "终端" })).toHaveCount(0);

    await page.getByRole("button", { name: /新对话/ }).click();
    await expect(page.getByTestId("chat-composer-input")).toBeVisible();
    await page.locator('button[data-testid^="sidebar-project-"]').first().click();
    await expect(page.getByTestId("workspace-composer-input")).toBeVisible();
    await page.getByTestId("terminal-toggle").click();
    await expect(page.locator(".terminal-panel-tab-shell")).toHaveCount(2);
    await page.getByRole("tab", { name: "终端 2" }).click();
    await expect(page.locator(".terminal-panel .xterm-screen")).toContainText("ready:term-2");

    await page.reload();
    await expect(page.getByTestId("sidebar-settings")).toBeVisible();
    await page.locator('button[data-testid^="sidebar-project-"]').first().click();
    await expect(page.getByTestId("workspace-composer-input")).toBeVisible();
    await page.getByTestId("terminal-toggle").click();
    await expect(page.locator(".terminal-panel-tab-shell")).toHaveCount(2);
    await page.getByRole("tab", { name: "终端 2" }).click();
    await expect(page.locator(".terminal-panel .xterm-screen")).toContainText("ready:term-2");

    await page.getByTitle("关闭终端 2标签").click();
    await expect(page.locator(".terminal-panel-tab-shell")).toHaveCount(1);
    await expect.poll(() => page.evaluate(() => {
      const calls = (window as unknown as { __fakeTerminal: { calls: Array<{ command: string; args: Record<string, unknown> }> } }).__fakeTerminal.calls;
      return calls.some((call) => call.command === "terminal_close" && call.args.sessionId === "term-2");
    })).toBe(true);
  });

  test("关闭存在前台任务的终端前需要确认", async ({ page, openApp, info }) => {
    await installFakeTerminalRuntime(page, info);
    await openApp();
    await page.getByTestId("terminal-toggle").click();
    await expect(page.getByRole("tab", { name: "终端 1" })).toBeVisible();
    await page.evaluate(() => {
      (window as unknown as { __fakeTerminal: { state: { busy: boolean } } }).__fakeTerminal.state.busy = true;
    });

    await page.getByTitle("关闭终端 1标签").click();
    await expect(page.getByRole("dialog")).toContainText("终端中仍有前台任务");
    await page.getByRole("button", { name: "取消" }).click();
    await expect(page.getByRole("tab", { name: "终端 1" })).toHaveCount(1);

    await page.getByTitle("关闭终端 1标签").click();
    await page.getByRole("button", { name: "结束终端" }).click();
    await expect(page.getByRole("tab", { name: "终端 1" })).toHaveCount(0);
  });

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
    await expect(page.getByTestId("side-dock-titlebar-host")).toHaveAttribute("data-tauri-drag-region", "true");
    await expect(page.locator("button.ad-tb-nav")).toHaveCount(1);
    await expect(page.locator("button.ad-tb-nav")).not.toHaveAttribute("data-tauri-drag-region", "true");
    await expect(page.locator(".ad-tb-nav-static")).toHaveCount(2);
    await expect(page.locator(".ad-tb-nav-static").first()).toHaveAttribute("data-tauri-drag-region", "true");

    await page.getByTitle("打开工作台").click();
    await expect(page.locator(".sd-titlebar-toolbar")).toHaveAttribute("data-tauri-drag-region", "true");
    await expect(page.locator(".sd-open-tabs")).toHaveAttribute("data-tauri-drag-region", "true");
    await expect(page.locator(".sd-tab-shell").first()).toHaveAttribute("data-tauri-drag-region", "true");
    await expect(page.locator(".sd-add-wrap")).toHaveAttribute("data-tauri-drag-region", "true");
    await expect(page.getByTestId("side-dock-tab-files")).not.toHaveAttribute("data-tauri-drag-region", "true");
  });

  test("macOS 放大工作台时标题避开 traffic lights", async ({ page, openApp }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "userAgent", {
        configurable: true,
        value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      });
      Object.defineProperty(window, "__TAURI__", {
        configurable: true,
        value: { core: { invoke: async () => null } },
      });
    });
    await openApp();

    await page.getByTitle("打开工作台").click();
    await page.getByTitle("放大到窗口").click();

    const activeTab = page.locator(".ad-titlebar").getByTestId("side-dock-tab-files");
    await expect(activeTab).toHaveText(/文件/);
    const activeTabBox = await activeTab.boundingBox();
    expect(activeTabBox).not.toBeNull();
    expect(activeTabBox!.x >= 88 || activeTabBox!.y >= 46).toBe(true);
  });

  test("Windows 放大工作台时不预留 macOS traffic lights 空白", async ({ page, openApp }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "userAgent", {
        configurable: true,
        value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      });
      Object.defineProperty(window, "__TAURI__", {
        configurable: true,
        value: { core: { invoke: async () => null } },
      });
    });
    await openApp();

    await page.getByTitle("打开工作台").click();
    await page.getByTitle("放大到窗口").click();

    await expect(page.locator(".sd-titlebar-toolbar.max")).toHaveCSS("padding-left", "0px");
  });

  test("工作台使用顶层动态标签，并支持输入自定义浏览器地址", async ({ page, openApp }) => {
    await openApp();
    await page.getByTitle("打开工作台").click();

    const dock = page.getByTestId("side-dock");
    const dockTitlebar = page.getByTestId("side-dock-titlebar-area");
    await expect(dock.locator(".sd-top")).toHaveCount(0);
    await expect(page.locator(".ad-titlebar").getByTestId("side-dock-tab-files")).toBeVisible();
    const tabBox = await page.getByTestId("side-dock-tab-files").boundingBox();
    const dockBox = await dock.boundingBox();
    const dockTitlebarBox = await dockTitlebar.boundingBox();
    const drawerBox = await page.getByTitle("关闭工作台").boundingBox();
    expect(tabBox).not.toBeNull();
    expect(dockBox).not.toBeNull();
    expect(dockTitlebarBox).not.toBeNull();
    expect(drawerBox).not.toBeNull();
    expect(Math.abs(tabBox!.y + tabBox!.height / 2 - (drawerBox!.y + drawerBox!.height / 2))).toBeLessThan(2);
    expect(Math.abs(dockTitlebarBox!.x - dockBox!.x)).toBeLessThan(2);
    expect(Math.abs(dockTitlebarBox!.width - dockBox!.width)).toBeLessThan(2);
    expect(tabBox!.x - dockTitlebarBox!.x).toBeLessThan(24);
    await expect(dockTitlebar).toHaveCSS("border-left-width", "1px");
    await expect(page.getByTestId("side-dock-tab-preview")).toHaveCount(0);

    await page.getByTestId("sidebar-settings").click();
    await expect(dockTitlebar).toBeHidden();
    await page.getByTestId("settings-back").click();
    await expect(page.getByTestId("side-dock-tab-files")).toBeVisible();

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

    await page.getByTitle("关闭浏览器标签").click();
    await expect(page.getByTestId("side-dock-tab-preview")).toHaveCount(0);
    await expect(page.getByTestId("side-dock-tab-files")).toHaveClass(/on/);

    await page.setViewportSize({ width: 960, height: 720 });
    await page.getByTestId("side-dock-add-view").click();
    const narrowMenuBox = await page.getByTestId("side-dock-view-menu").boundingBox();
    expect(narrowMenuBox).not.toBeNull();
    expect(narrowMenuBox!.x).toBeGreaterThanOrEqual(0);
    expect(narrowMenuBox!.x + narrowMenuBox!.width).toBeLessThanOrEqual(960);
    await page.keyboard.press("Escape");
    await page.getByTitle("关闭文件标签").click();
    await expect(dock).not.toBeVisible();
    await page.getByTitle("打开工作台").click();
    await expect(page.getByTestId("side-dock-tab-files")).toHaveClass(/on/);
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
    await page.getByRole("button", { name: "发送", exact: true }).click();

    const link = page.getByRole("link", { name: "示例页面" });
    await link.click();
    const address = page.getByRole("textbox", { name: "浏览器地址" });
    await expect(page.getByTestId("side-dock-tab-preview")).toHaveClass(/on/);
    await expect(address).toHaveValue("https://example.com/docs");

    await address.fill("example.org/other");
    await address.press("Enter");
    await page.getByTestId("side-dock-add-view").click();
    await page.getByTestId("side-dock-view-menu").getByRole("menuitem", { name: "文件" }).click();
    await expect(page.getByTestId("side-dock-tab-files")).toHaveClass(/on/);

    await link.click();
    await expect(page.getByTestId("side-dock-tab-preview")).toHaveClass(/on/);
    await expect(address).toHaveValue("https://example.com/docs");
  });

  test("左右布局拖拽线贯穿窗口且不额外占用布局间隔", async ({ page, openApp }) => {
    await openApp();
    const viewport = page.viewportSize();
    const sidebar = page.locator(".ad-sessions-wrap");
    const main = page.locator(".ad-main");
    const sidebarHandle = page.locator(".ad-resizer");
    const [sidebarBox, mainBox, sidebarGrip] = await Promise.all([
      sidebar.boundingBox(),
      main.boundingBox(),
      sidebarHandle.boundingBox(),
    ]);
    expect(viewport).not.toBeNull();
    expect(sidebarBox).not.toBeNull();
    expect(mainBox).not.toBeNull();
    expect(sidebarGrip).not.toBeNull();
    expect(Math.round(sidebarGrip!.y)).toBe(0);
    expect(Math.round(sidebarGrip!.height)).toBe(viewport!.height);
    expect(Math.abs(mainBox!.x - (sidebarBox!.x + sidebarBox!.width))).toBeLessThanOrEqual(1);

    await page.mouse.move(sidebarGrip!.x + sidebarGrip!.width / 2, 20);
    await page.mouse.down();
    await page.mouse.move(sidebarGrip!.x + 60, 20);
    await page.mouse.up();
    await expect.poll(async () => Math.round((await sidebar.boundingBox())?.width ?? 0)).toBeGreaterThan(
      Math.round(sidebarBox!.width + 40),
    );

    await page.getByTitle("打开工作台").click();
    const dock = page.getByTestId("side-dock");
    const dockHandle = page.getByTestId("side-dock-resize-handle");
    const [dockBefore, dockGrip] = await Promise.all([dock.boundingBox(), dockHandle.boundingBox()]);
    expect(dockBefore).not.toBeNull();
    expect(dockGrip).not.toBeNull();
    expect(Math.round(dockGrip!.y)).toBe(0);
    expect(Math.round(dockGrip!.height)).toBe(viewport!.height);

    await page.mouse.move(dockGrip!.x + dockGrip!.width / 2, 20);
    await page.mouse.down();
    await page.mouse.move(dockGrip!.x - 70, 20);
    await page.mouse.up();
    await expect.poll(async () => Math.round((await dock.boundingBox())?.width ?? 0)).toBeGreaterThan(
      Math.round(dockBefore!.width + 50),
    );

    await page.getByTestId("sidebar-settings").click();
    await expect(page.getByTestId("side-dock-resize-handle")).toHaveCount(0);
  });

  test("收件箱内部拖拽线贯穿内容区且不额外占用布局间隔", async ({ page, openApp }) => {
    await openApp();
    await page.getByRole("button", { name: "收件箱", exact: true }).click();

    const listHeader = page.locator(".inbox-list-head");
    await expect(listHeader.getByRole("heading", { name: "收件箱" })).toHaveCount(0);
    await expect(listHeader.locator(".inbox-eyebrow")).toHaveText("外部渠道");
    await expect(page.getByTestId("inbox-refresh").locator(".lucide-rotate-cw")).toBeVisible();

    const inbox = page.getByTestId("inbox-page");
    const list = page.locator(".inbox-list");
    const conversation = page.locator(".inbox-conversation");
    const handle = page.getByTestId("inbox-resize-handle");
    const line = handle.locator("span");
    const [inboxBox, listBefore, conversationBox, handleBox, lineBox] = await Promise.all([
      inbox.boundingBox(),
      list.boundingBox(),
      conversation.boundingBox(),
      handle.boundingBox(),
      line.boundingBox(),
    ]);
    expect(inboxBox).not.toBeNull();
    expect(listBefore).not.toBeNull();
    expect(conversationBox).not.toBeNull();
    expect(handleBox).not.toBeNull();
    expect(lineBox).not.toBeNull();
    expect(Math.round(handleBox!.y)).toBe(Math.round(inboxBox!.y));
    expect(Math.round(handleBox!.height)).toBe(Math.round(inboxBox!.height));
    expect(Math.round(lineBox!.height)).toBe(Math.round(handleBox!.height));
    expect(Math.abs(conversationBox!.x - (listBefore!.x + listBefore!.width))).toBeLessThanOrEqual(1);

    await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + 8);
    await page.mouse.down();
    await page.mouse.move(handleBox!.x + 50, handleBox!.y + 8);
    await page.mouse.up();
    await expect.poll(async () => Math.round((await list.boundingBox())?.width ?? 0)).toBeGreaterThan(
      Math.round(listBefore!.width + 35),
    );
  });

  test("工作台宽度可拖拽并持久化，窄窗口改为浮层而不是消失", async ({ page, openApp }) => {
    await openApp();
    const toggle = page.getByTitle("打开工作台");
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
    await page.getByTitle("打开工作台").click();
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
    const narrowToggle = page.getByTitle("打开工作台");
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
