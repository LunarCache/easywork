import { test, expect } from "./fixtures.js";

test.describe("knowledge base and skills e2e", () => {
  test("知识库支持搜索、预览和删除已有文档", async ({ page, openApp, client }) => {
    const { doc } = await client.kbIngest({
      kbId: "playwright-docs",
      source: "kb-guide.md",
      text: "# KB Guide\n\nKnowledge base document for Playwright e2e.",
    });

    await openApp();
    await page.getByTestId("sidebar-settings").click();
    await page.getByTestId("settings-nav-kb").click();

    await expect(page.getByTestId("kb-overlay")).toBeVisible();
    await expect(page.getByTestId("kb-collection-playwright-docs")).toBeVisible();

    await page.getByTestId("kb-search-input").fill("kb-guide");
    await expect(page.getByTestId(`kb-doc-${doc.id}`)).toBeVisible();

    await page.getByTestId(`kb-doc-${doc.id}`).click();
    await expect(page.getByTestId("file-viewer")).toBeVisible();
    await expect(page.getByText("Knowledge base document for Playwright e2e.")).toBeVisible();

    await page.getByTestId(`kb-doc-${doc.id}`).hover();
    await page.getByTestId(`kb-doc-delete-${doc.id}`).click();
    await page.getByRole("button", { name: "删除" }).click();

    await expect.poll(async () => (await client.kbDocs("playwright-docs")).docs.some((item) => item.id === doc.id)).toBe(false);
    await expect(page.getByTestId(`kb-doc-${doc.id}`)).toHaveCount(0);
  });

  test("Skills 页支持新建模板并打开详情", async ({ page, openApp, client }) => {
    const skillName = `pw-skill-${Date.now().toString().slice(-6)}`;

    await openApp();
    await page.getByTestId("sidebar-settings").click();
    await page.getByTestId("settings-nav-skills").click();

    await expect(page.getByTestId("skills-source-builtin")).toBeVisible();
    await expect(page.getByTestId("skills-source-agents")).toBeVisible();
    await expect(page.getByText("EasyWork 内置全局技能")).toBeVisible();
    await expect(page.getByText(/^主目录\s/)).toHaveCount(0);

    await page.getByTestId("skills-new-button").click();
    await expect(page.getByTestId("skills-new-inline")).toBeVisible();
    await page.getByTestId("skills-new-input").fill(skillName);
    await page.getByTestId("skills-new-submit").click();

    await expect
      .poll(async () => {
        const skills = await client.skillsInfo();
        return skills.skills.find((item) => item.frontmatter.name === skillName)?.id ?? null;
      })
      .not.toBeNull();

    const info = await client.skillsInfo();
    const created = info.skills.find((item) => item.frontmatter.name === skillName);
    expect(created).toBeTruthy();
    expect(created!.source.id).toBe("builtin");

    await page.getByTestId(`skill-card-${created!.id}`).click();
    await expect(page.getByTestId("skills-detail-name")).toHaveText(skillName);
    await expect(page.getByText(`open_skill("${skillName}")`)).toBeVisible();

    await page.getByTestId("skills-detail-back").click();
    await expect(page.getByTestId("skills-new-button")).toBeVisible();
    await expect(page.getByTestId("skills-source-builtin")).toContainText(skillName);
    await expect(page.getByTestId(`skill-card-${created!.id}`)).toBeVisible();
    await expect(page.getByTestId(`skill-status-${created!.id}`)).toHaveCount(0);

    await page.getByTestId(`skill-toggle-${created!.id}`).click();
    await expect(page.getByTestId(`skill-status-${created!.id}`)).toHaveText("已关闭");
    await page.reload();
    await page.getByTestId("sidebar-settings").click();
    await page.getByTestId("settings-nav-skills").click();
    await expect(page.getByTestId(`skill-status-${created!.id}`)).toHaveText("已关闭");

    await page.getByTestId(`skill-toggle-${created!.id}`).click();
    await expect(page.getByTestId(`skill-status-${created!.id}`)).toHaveCount(0);
  });

  test("Skill Candidate 需在审核页批准，显式学习只生成 Agent 提示", async ({ page, openApp, client }) => {
    const suffix = Date.now().toString().slice(-6);
    const name = `pw-learned-${suffix}`;
    const candidate = await client.stageSkillCandidate({
      name,
      description: "A reviewed Playwright workflow",
      triggerConditions: ["when validating candidate review"],
      scope: "global",
      proposedSkillMd: `---\nname: ${name}\ndescription: A reviewed Playwright workflow\nwhenToUse: when validating candidate review\nversion: "0.1.0"\n---\n# Workflow\n## Procedure\n1. Run the check.\n## Pitfalls\n- Keep it bounded.\n## Verification\n- Confirm the result.\n`,
      requiredTools: [],
      sourceThreadIds: ["pw-source"],
      evidence: [{ sourceThreadId: "pw-source", summary: "The flow succeeded" }],
      reason: "Reusable e2e flow",
      createdBy: "foreground-agent",
    });
    expect((await client.skillsInfo()).skills.some((skill) => skill.id === name)).toBe(false);

    await openApp();
    await page.getByTestId("sidebar-settings").click();
    await page.getByTestId("settings-nav-skills").click();
    await page.getByTestId("skills-tab-pending").click();
    await page.getByTestId(`skill-candidate-${candidate.id}`).click();
    await expect(page.getByTestId("skill-candidate-editor")).toContainText("## Verification");
    await expect(page.getByTestId("skill-candidate-diff")).toContainText("+++ b/SKILL.md");
    await page.getByTestId("skill-candidate-approve").click();
    await expect.poll(async () => (await client.skillsInfo()).skills.some((skill) => skill.id === name)).toBe(true);

    await page.getByTestId("skills-learn-button").click();
    await expect(page.getByTestId("skills-learn-dialog")).toBeVisible();
    await page.locator(".mem-add-textarea").fill("提炼一套可复用的发布检查流程");
    await page.getByTestId("skills-learn-submit").click();
    await expect(page.getByTestId("chat-composer-input")).toContainText("stage_skill_candidate");
    expect((await client.listSkillCandidates()).filter((item) => item.status === "pending")).toHaveLength(0);
  });
});
