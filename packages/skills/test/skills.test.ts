import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolExecContext } from "@ew/shared";
import { SkillManager } from "../src/index.js";
import { parseFrontmatter } from "../src/frontmatter.js";

let tmp: string | undefined;
let tmpRoots: string[] = [];
function makeSkillDir(): string {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ew-skills-"));
  const dir = path.join(tmp, "pdf-fill");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---
name: PDF Filler
description: 填写 PDF 表单
whenToUse: 当用户需要填写 PDF 表单字段时
version: 1.0.0
---
# PDF Filler
详细步骤：使用 fill.py 脚本……`,
  );
  fs.writeFileSync(path.join(dir, "fill.py"), "print('fill')");
  return tmp;
}

function makeSkillRoot(name: string, body: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ew-skills-"));
  tmpRoots.push(root);
  const dir = path.join(root, name.toLowerCase().replace(/[^a-z0-9]+/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---
name: ${name}
description: ${body}
whenToUse: tests
---
# ${name}
${body}`,
  );
  return root;
}

afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  for (const root of tmpRoots) fs.rmSync(root, { recursive: true, force: true });
  tmp = undefined;
  tmpRoots = [];
});

const ctx: ToolExecContext = {
  sessionId: "t",
  workspaceDir: "/tmp",
  signal: new AbortController().signal,
  approval: { async request() { return "approve"; } },
};

describe("parseFrontmatter", () => {
  it("解析 key:value + 正文", () => {
    const { data, body } = parseFrontmatter("---\nname: X\nwhenToUse: always\n---\nhello body");
    expect(data.name).toBe("X");
    expect(data.whenToUse).toBe("always");
    expect(body.trim()).toBe("hello body");
  });
  it("解析内联数组", () => {
    const { data } = parseFrontmatter("---\nallowedTools: [a, b, c]\n---\n");
    expect(data.allowedTools).toEqual(["a", "b", "c"]);
  });
});

describe("SkillManager", () => {
  it("发现 SKILL.md 并解析 frontmatter + 脚本", async () => {
    const dir = makeSkillDir();
    const sm = new SkillManager([dir]);
    const skills = await sm.discover();
    expect(skills).toHaveLength(1);
    expect(skills[0]!.frontmatter.name).toBe("PDF Filler");
    expect(skills[0]!.id).toBe("pdf-filler");
    expect(skills[0]!.scripts).toContain("fill.py");
  });

  it("同名技能保留先扫描目录的版本", async () => {
    const first = makeSkillRoot("Same Skill", "first");
    const second = makeSkillRoot("Same Skill", "second");
    const sm = new SkillManager([first, second]);
    const skills = await sm.discover();
    expect(skills).toHaveLength(1);
    expect(skills[0]!.dir.startsWith(first)).toBe(true);
  });

  it("递归发现较深目录里的 SKILL.md", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ew-skills-"));
    tmpRoots.push(root);
    const dir = path.join(root, "plugin", "version", "skills", "nested-skill");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "SKILL.md"),
      `---
name: Nested Skill
description: nested
whenToUse: tests
---
# Nested Skill`,
    );
    const sm = new SkillManager([root]);
    const skills = await sm.discover();
    expect(skills.map((s) => s.id)).toContain("nested-skill");
  });

  it("systemPromptCatalog 含 name/description/whenToUse", async () => {
    const sm = new SkillManager([makeSkillDir()]);
    await sm.discover();
    const cat = sm.systemPromptCatalog();
    expect(cat).toContain("PDF Filler");
    expect(cat).toContain("填写 PDF 表单");
    expect(cat).toContain("open_skill");
  });

  it("open_skill 工具懒加载完整正文（第二层披露）", async () => {
    const sm = new SkillManager([makeSkillDir()]);
    await sm.discover();
    const [openSkill] = await sm.toolProvider().tools(ctx);
    expect(openSkill!.definition.name).toBe("open_skill");
    const res = await openSkill!.execute({ skillId: "pdf-filler" }, ctx);
    expect(String(res.content)).toContain("详细步骤");
    const miss = await openSkill!.execute({ skillId: "nope" }, ctx);
    expect(miss.isError).toBe(true);
  });
});
