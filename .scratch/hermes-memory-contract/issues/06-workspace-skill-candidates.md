# Workspace Skill Candidates and source lifecycle

Status: ready-for-agent
Type: task
Blocked by: 05

## What to build

Support workspace-scoped Skill Candidates that activate only inside their trusted workspace, cannot escape through paths or symlinks, and retain correct single-source and multi-source deletion behavior.

## Acceptance criteria

- [ ] Workspace candidates default to the current workspace and can be deliberately changed to global before approval.
- [ ] Approved workspace Skills are written to the trusted project Skill source and discovered by pi on the next run.
- [ ] Path and symlink escape attempts are rejected at staging and approval.
- [ ] Deleting a source removes its evidence and deletes an unapproved candidate when no sources remain.
- [ ] Removing a workspace clears candidate state without deleting unrelated user files.

## Comments
