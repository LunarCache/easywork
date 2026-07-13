# Workspace Skill Candidates and source lifecycle

Status: done
Type: task
Blocked by: 05

## What to build

Support workspace-scoped Skill Candidates that activate only inside their trusted workspace, cannot escape through paths or symlinks, and retain correct single-source and multi-source deletion behavior.

## Acceptance criteria

- [x] Workspace candidates default to the current workspace and can be deliberately changed to global before approval.
- [x] Approved workspace Skills are written to the trusted project Skill source and discovered by pi on the next run.
- [x] Path and symlink escape attempts are rejected at staging and approval.
- [x] Deleting a source removes its evidence and deletes an unapproved candidate when no sources remain.
- [x] Removing a workspace clears candidate state without deleting unrelated user files.

## Comments

- 2026-07-12: Completed workspace scope defaults, trusted `.agents/skills` activation, confinement, multi-source cleanup, and project removal behavior.
