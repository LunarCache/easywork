import { z } from "zod";

/** SKILL.md frontmatter。description + whenToUse 驱动自动触发（渐进披露）。 */
export const SkillFrontmatterSchema = z.object({
  name: z.string(),
  description: z.string(),
  whenToUse: z.string(),
  version: z.string().optional(),
  allowedTools: z.array(z.string()).optional(),
});
export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

/** 一个已发现的 Skill（body 懒加载）。 */
export const SkillSchema = z.object({
  id: z.string(),
  dir: z.string(),
  frontmatter: SkillFrontmatterSchema,
  bodyPath: z.string(),
  scripts: z.array(z.string()),
  resources: z.array(z.string()),
});
export type Skill = z.infer<typeof SkillSchema>;
