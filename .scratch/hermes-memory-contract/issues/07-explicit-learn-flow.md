# Explicit Learn flow

Status: done
Type: task
Blocked by: 06

## What to build

Add a user-directed Learn flow that turns the current task, free text, a local path, or a URL into a Skill Candidate through the foreground Agent and the same review pipeline.

## Acceptance criteria

- [x] Chat and Skills settings offer a clear `学习 Skill` entry point.
- [x] Current-conversation, text, path, and URL inputs compose a normal Agent turn rather than using a second inconsistent extraction backend.
- [x] The authoring prompt requires triggers, procedure, pitfalls, verification, and grounded commands/APIs.
- [x] Learn output is always a candidate with diff and validation, never an immediately active Skill.
- [x] Workspace permissions and URL/file failures surface actionable errors.

## Comments

- 2026-07-12: Completed Chat/Settings entry points, normal foreground Agent composition, confined files, SSRF-safe URLs, and staging-only output.
