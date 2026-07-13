# Explicit Learn flow

Status: ready-for-agent
Type: task
Blocked by: 06

## What to build

Add a user-directed Learn flow that turns the current task, free text, a local path, or a URL into a Skill Candidate through the foreground Agent and the same review pipeline.

## Acceptance criteria

- [ ] Chat and Skills settings offer a clear `学习 Skill` entry point.
- [ ] Current-conversation, text, path, and URL inputs compose a normal Agent turn rather than using a second inconsistent extraction backend.
- [ ] The authoring prompt requires triggers, procedure, pitfalls, verification, and grounded commands/APIs.
- [ ] Learn output is always a candidate with diff and validation, never an immediately active Skill.
- [ ] Workspace permissions and URL/file failures surface actionable errors.

## Comments
