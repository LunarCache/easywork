# Deepen the Agent Turn UI module

Status: open
Type: task
Blocked by: 01

## Question

How can Chat and Workspace share one deep Agent Turn UI module that owns send, retry, stop, AgentEvent consumption, approval, usage, transient status, artifacts, errors, and completion while preserving their distinct policies and current UI behavior?

## Acceptance criteria

- [ ] A failing test first locks the full Agent Turn lifecycle at the new module interface using an in-memory daemon stream adapter.
- [ ] Chat and Workspace no longer contain duplicate runAgent event loops or duplicate retry/stop/approval orchestration.
- [ ] Workspace-only approval sequencing and refresh effects remain policies behind the seam rather than branches duplicated inside callers.
- [ ] Cancellation, regeneration, usage, retry, compaction, artifact, error, and final behavior remain compatible.
- [ ] Old tests that only lock shallow reducer/helper structure are removed when replacement coverage exists.
- [ ] Targeted Vitest and composer Playwright coverage pass.
- [ ] Code review finds no Standards or Spec violations.
- [ ] The change is committed independently.

## Comments
