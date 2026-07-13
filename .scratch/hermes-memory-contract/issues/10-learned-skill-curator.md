# Curate learned Skills safely

Status: done
Type: task
Blocked by: 09

## What to build

Maintain learned Skills through active, stale, and recoverably archived states with pin, restore, snapshots, reports, and rollback; optional LLM consolidation only proposes reviewable diffs.

## Acceptance criteria

- [x] Deterministic inactivity rules can mark learned Skills stale and archive them without hard deletion.
- [x] Pinning protects a learned Skill from automatic transitions and consolidation proposals.
- [x] Archive/restore, pre-run snapshots, reports, and rollback are available from API and UI.
- [x] Built-in, external, hub-installed, and user-authored Skills are never curated automatically.
- [x] LLM consolidation is off by default and cannot apply changes without approval.

## Comments

- 2026-07-12: Completed deterministic lifecycle maintenance, pre-transition snapshots, readable reports, UI rollback, ownership guards, and opt-in candidate-only consolidation.
