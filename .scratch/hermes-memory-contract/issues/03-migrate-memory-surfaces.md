# Migrate memory behavior and surfaces

Status: done
Type: task
Blocked by: 02

## What to build

Move extraction, recall, manifests, Markdown projection, APIs, and UI to User Profile, Agent Notes, Workspace Memory, and the derived fact pool while turning legacy `global.skills` content into reviewable migration output rather than active memory.

## Acceptance criteria

- [x] New runs no longer write or inject the `global.skills` memory layer.
- [x] Procedural legacy entries become pending migration candidates; factual entries remain available as facts or Agent Notes.
- [x] The memory page no longer presents an active `技能` memory section.
- [x] Existing `skills.md` is preserved as a migration backup and is not silently discarded.
- [x] Recall, Markdown editing, and UI behavior remain usable throughout migration.

## Comments

- 2026-07-12: Completed legacy classification, read-only ambiguous pool, backup preservation, Agent Notes UI, and derived-pool recall behavior.
