import fs from "node:fs";
import path from "node:path";
import type { Skill, Tool, ToolProvider } from "@ew/shared";
import { parseFrontmatter } from "./frontmatter.js";

function asString(v: string | string[] | undefined, fallback = ""): string {
  if (Array.isArray(v)) return v.join(", ");
  return v ?? fallback;
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Anthropic 风格 Skills 运行时。
 * - discover：扫描各目录下的 SKILL.md，仅解析 frontmatter（渐进披露第一层）。
 * - catalog：把 name/description/whenToUse 注入系统提示（触发面）。
 * - toolProvider：暴露 open_skill 工具，模型决定使用时才懒加载完整 SKILL.md（第二层）。
 */
export class SkillManager {
  private skills = new Map<string, Skill>();

  constructor(private readonly dirs: string[], private readonly maxDepth = 6) {}

  /** 重新扫描所有目录。 */
  async discover(): Promise<Skill[]> {
    this.skills.clear();
    for (const dir of this.dirs) await this.scanDir(dir);
    return [...this.skills.values()];
  }

  private async scanDir(dir: string, depth = 0): Promise<void> {
    const skillFile = path.join(dir, "SKILL.md");
    if (fs.existsSync(skillFile)) {
      await this.addSkill(dir, skillFile);
      return;
    }
    if (depth >= this.maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === "node_modules" || e.name === ".git") continue;
      await this.scanDir(path.join(dir, e.name), depth + 1);
    }
  }

  private async addSkill(skillDir: string, skillFile: string): Promise<void> {
    try {
      const raw = await fs.promises.readFile(skillFile, "utf8");
      const { data } = parseFrontmatter(raw);
      const name = asString(data.name) || path.basename(skillDir);
      const id = slug(name);
      if (this.skills.has(id)) return;
      const resources = (await fs.promises.readdir(skillDir)).filter((f) => f !== "SKILL.md");
      const scripts = resources.filter((f) => /\.(sh|py|js|mjs|ts)$/.test(f));
      this.skills.set(id, {
        id,
        dir: skillDir,
        frontmatter: {
          name,
          description: asString(data.description),
          whenToUse: asString(data.whenToUse ?? data["when-to-use"]),
          ...(data.version ? { version: asString(data.version) } : {}),
          ...(Array.isArray(data.allowedTools) ? { allowedTools: data.allowedTools } : {}),
        },
        bodyPath: skillFile,
        scripts,
        resources,
      });
    } catch {
      /* 跳过坏 SKILL.md */
    }
  }

  list(): Skill[] {
    return [...this.skills.values()];
  }

  /** 完整加载某技能正文（第二层披露）。 */
  async loadBody(skillId: string): Promise<string | null> {
    const s = this.skills.get(skillId);
    if (!s) return null;
    const raw = await fs.promises.readFile(s.bodyPath, "utf8");
    return parseFrontmatter(raw).body.trim();
  }

  /** 系统提示用的技能目录（仅 name/description/whenToUse）。 */
  systemPromptCatalog(): string {
    const skills = this.list();
    if (skills.length === 0) return "";
    const lines = skills.map(
      (s) =>
        `- ${s.frontmatter.name} (id: ${s.id}): ${s.frontmatter.description}` +
        (s.frontmatter.whenToUse ? ` — 何时用: ${s.frontmatter.whenToUse}` : ""),
    );
    return [
      "可用技能（需要时调用 open_skill(skillId) 获取完整说明）:",
      ...lines,
    ].join("\n");
  }

  /** 暴露 open_skill 工具的 ToolProvider。 */
  toolProvider(): ToolProvider {
    const openSkill: Tool = {
      definition: {
        name: "open_skill",
        description: "加载某个技能的完整说明（SKILL.md 正文），以便按其指引完成任务。",
        parameters: {
          type: "object",
          properties: { skillId: { type: "string", description: "技能 id（见系统提示中的技能目录）" } },
          required: ["skillId"],
        },
      },
      source: "skill",
      requiresApproval: "never",
      execute: async (args) => {
        const skillId = (args as { skillId?: string })?.skillId ?? "";
        const body = await this.loadBody(slug(skillId)).catch(() => null);
        if (body == null) return { content: `未找到技能: ${skillId}`, isError: true };
        return { content: body };
      },
    };
    return {
      tools: async () => (this.list().length > 0 ? [openSkill] : []),
    };
  }
}
