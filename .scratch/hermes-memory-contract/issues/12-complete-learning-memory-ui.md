# Complete learning and memory frontend

Status: done

## Goal

Expose the remaining reviewed Skill-learning and additive-memory lifecycle through the desktop UI so users do not need to call the SDK or HTTP API directly.

## Acceptance criteria

- [x] Memory settings show additive provider configuration/status and allow toggling a configured provider without implying that it owns local writes.
- [x] Memory settings expose the read-only legacy `global.skills` migration pool, including ambiguous items and their migration disposition.
- [x] Learned Skills accept success, failure, and correction feedback; a correction can stage a reviewable patch candidate without mutating the active Skill.
- [x] Learned Skill snapshots are shown as a selectable timeline and users can roll back to a chosen snapshot.
- [x] Candidate source conversations and evidence are presented as links that open the corresponding task.
- [x] Pending background candidates and background review failures surface as a global Settings/Skills attention badge.
- [x] SDK, UI e2e, lint, typecheck, build, unit tests, and Playwright suites pass.
- [x] The change receives Standards and Spec review and is committed locally without staging unrelated user changes.

## Comments

- 2026-07-12: Started as the frontend-completion follow-up to PRD Issues 02-11.
- 2026-07-12: Completed all six UI surfaces, shared SDK/contracts, keep-alive refresh and background-settle notifications; Standards and Spec reviews both finished with 0 findings. Validation: 343 Vitest passed / 1 skipped and 26 Playwright passed.
