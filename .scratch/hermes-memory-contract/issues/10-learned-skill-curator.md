# Curate learned Skills safely

Status: ready-for-agent
Type: task
Blocked by: 09

## What to build

Maintain learned Skills through active, stale, and recoverably archived states with pin, restore, snapshots, reports, and rollback; optional LLM consolidation only proposes reviewable diffs.

## Acceptance criteria

- [ ] Deterministic inactivity rules can mark learned Skills stale and archive them without hard deletion.
- [ ] Pinning protects a learned Skill from automatic transitions and consolidation proposals.
- [ ] Archive/restore, pre-run snapshots, reports, and rollback are available from API and UI.
- [ ] Built-in, external, hub-installed, and user-authored Skills are never curated automatically.
- [ ] LLM consolidation is off by default and cannot apply changes without approval.

## Comments
