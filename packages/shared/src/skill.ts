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

/** Skill 发现来源：只描述全局来源；项目级 skills 不进入管理页。 */
export const SkillSourceKindSchema = z.enum([
  "builtin",
  "agents",
  "custom",
]);
export type SkillSourceKind = z.infer<typeof SkillSourceKindSchema>;

export const SkillSourceSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: SkillSourceKindSchema,
  dir: z.string(),
  primary: z.boolean().optional(),
});
export type SkillSource = z.infer<typeof SkillSourceSchema>;

/** 一个已发现的 Skill（body 懒加载）。 */
export const SkillSchema = z.object({
  id: z.string(),
  dir: z.string(),
  source: SkillSourceSchema,
  frontmatter: SkillFrontmatterSchema,
  bodyPath: z.string(),
  scripts: z.array(z.string()),
  resources: z.array(z.string()),
});
export type Skill = z.infer<typeof SkillSchema>;
