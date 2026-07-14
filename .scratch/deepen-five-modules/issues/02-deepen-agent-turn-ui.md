# Deepen the Agent Turn UI module

Status: done
Type: task
Blocked by: 01

## Question

How can Chat and Workspace share one deep Agent Turn UI module that owns send, retry, stop, AgentEvent consumption, approval, usage, transient status, artifacts, errors, and completion while preserving their distinct policies and current UI behavior?

## Acceptance criteria

- [x] A failing test first locks the full Agent Turn lifecycle at the new module interface using an in-memory daemon stream adapter.
- [x] Chat and Workspace no longer contain duplicate runAgent event loops or duplicate retry/stop/approval orchestration.
- [x] Workspace-only approval sequencing and refresh effects remain policies behind the seam rather than branches duplicated inside callers.
- [x] Cancellation, regeneration, usage, retry, compaction, artifact, error, and final behavior remain compatible.
- [x] Old tests that only lock shallow reducer/helper structure are removed when replacement coverage exists.
- [x] Targeted Vitest and composer Playwright coverage pass.
- [x] Code review finds no Standards or Spec violations.
- [x] The change is committed independently.

## Comments

- 2026-07-14: Claimed for test-first implementation at the agreed Agent Turn UI module seam.
- 2026-07-14: Implemented `AgentTurnController` plus a thin React adapter; Chat and Workspace now provide only request, sequencing, and refresh policy.
- 2026-07-14: Kept `agent-stream.test.ts` because its persistence projection coverage is distinct from the new lifecycle tests; no superseded shallow test remained.
- 2026-07-14: Verified 5 Agent Turn tests, 4 Agent Stream tests, root lint, full typecheck, and 14 composer Playwright tests. Standards and Spec reviews both pass after resolving all review findings.
