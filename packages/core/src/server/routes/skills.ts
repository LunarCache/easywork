import fs from "node:fs";
import fsPath from "node:path";
import type { CoreHttpContext } from "../context.js";

export function registerSkillRoutes(ctx: CoreHttpContext): void {
  const { app, skills, skillsDir, skillCandidates } = ctx;

  app.get("/skills", async () => {
    await skills.discover().catch(() => {});
    return { skills: skills.list(), dir: skillsDir, sources: skills.sources() };
  });

  app.get("/skills/:id/body", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const skill = skills.list().find((s) => s.id === id);
    if (!skill) return reply.code(404).send({ error: "not_found" });
    try {
      const body = fs.readFileSync(skill.bodyPath, "utf8");
      skillCandidates.recordViewByPath(skill.bodyPath);
      return { body, bodyPath: skill.bodyPath };
    } catch (e) {
      return reply.code(500).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post("/skills/open", async (_req, reply) => {
    try {
      fs.mkdirSync(skillsDir, { recursive: true });
      const cmd =
        process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
      const { spawn } = await import("node:child_process");
      spawn(cmd, [skillsDir], { detached: true, stdio: "ignore" }).unref();
      return { ok: true, dir: skillsDir };
    } catch (e) {
      return reply.code(500).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post("/skills/template", async (req, reply) => {
    const body = (req.body ?? {}) as { name?: string };
    const name = (body.name ?? "my-skill").replace(/[^a-zA-Z0-9._-]+/g, "-").toLowerCase() || "my-skill";
    const dir = fsPath.join(skillsDir, name);
    const file = fsPath.join(dir, "SKILL.md");
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (!fs.existsSync(file)) {
        fs.writeFileSync(
          file,
          `---
name: ${name}
description: 一句话说明这个技能做什么（会进系统提示目录）
whenToUse: 描述什么情况下模型应该调用 open_skill 加载本技能
version: "0.1.0"
---

# ${name}

在这里写技能正文：步骤、约定、示例。模型调用 open_skill("${name}") 时才会注入这部分内容。
`,
        );
      }
      await skills.discover().catch(() => {});
      return { ok: true, file };
    } catch (e) {
      return reply.code(500).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });
}
