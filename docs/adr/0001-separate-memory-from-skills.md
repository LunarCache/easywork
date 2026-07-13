---
status: accepted
---

# Separate durable facts from executable Skills

EasyWork separates factual memory from procedural Skills. Core Memory contains only the User Profile and Agent Notes; Workspace Memory contains workspace conventions, decisions, and pitfalls; automatically learned facts remain source-owned Extracted Facts until promoted. The existing `global.skills` memory layer will be removed because flat recalled text is not a discoverable or executable Skill. SQLite is canonical for memory and provenance, Markdown is an editable projection, `SKILL.md` packages are canonical for Skills, and external memory providers are additive rather than replacements for the local contract. Memory changes must become available no later than the next agent turn.
