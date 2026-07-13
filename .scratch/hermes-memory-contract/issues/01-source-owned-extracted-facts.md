# Source-owned Extracted Facts and promotion

Status: done
Type: task
Blocked by: None

## What to build

Make automatically extracted facts visibly owned by their Source Conversation, delete them with that conversation, and let the user promote a useful fact into an independently retained Curated Fact from the memory UI.

## Acceptance criteria

- [x] Memory items expose explicit origin, lifecycle state, and source conversation instead of deriving the UI label from a nullable session ID.
- [x] Passive extraction writes source-owned Extracted Facts; manual and foreground-agent writes produce independent Curated Facts.
- [x] Deleting a Source Conversation removes its unpromoted Extracted Facts and pending extraction buffer while leaving Curated Facts intact.
- [x] The memory API and SDK support promoting an Extracted Fact.
- [x] The memory UI shows origin/source and offers `确认并保留` only for unpromoted Extracted Facts.
- [x] Schema migration preserves existing local memory and classifies existing rows safely.
- [x] Focused unit/integration/UI tests cover write, migration, promotion, and deletion behavior.

## Comments

- 2026-07-12: Claimed as the first implementation frontier after PRD approval.
- 2026-07-12: Added explicit `origin/state/sourceThreadId`, safe legacy migration, promotion API/SDK/UI, and source-owned deletion semantics.
- 2026-07-12: Deletion now crosses the per-thread run barrier and waits for in-flight extraction before removing derived facts; regression coverage locks the race.
- 2026-07-12: Final hardening covers shared provenance validation, pin-as-promotion, late-run tombstones, project deletion failures, and cold pi session deletion.
- 2026-07-12: History commit now shares the deletion barrier and persisted pi-state deletion is strict rather than best-effort.
- 2026-07-12: Verified lint, build, typecheck, 314 unit/integration tests (1 skipped), and 3 focused Playwright tests.
