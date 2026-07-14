# Deepen the Source Conversation lifecycle module

Status: done
Type: task
Blocked by: 03

## Question

How can all Source Conversation ownership and deletion behavior move behind one lifecycle seam without weakening the run barrier, provenance rules, failure reporting, or user workspace safety?

## Acceptance criteria

- [x] A failing integration test first locks deletion outcomes through the lifecycle interface with in-memory SQLite and temporary storage adapters.
- [x] The module owns the run/deletion barrier, extraction discard, Extracted Fact deletion, Skill Candidate source removal, Conversation/FTS deletion, pi session cleanup, and eligible scratch artifact cleanup.
- [x] Thread and Project deletion adapters no longer know the cleanup ordering.
- [x] Project deletion reuses the same Source Conversation lifecycle rather than repeating the sequence.
- [x] User workspace directories are never removed.
- [x] Scratch artifact deletion remains non-fatal; ownership cleanup failures remain observable as deletion failures.
- [x] ADR-0001 semantics remain unchanged.
- [x] Core targeted tests and route contract tests pass.
- [x] Code review passes and the change is committed independently.

## Comments

- 2026-07-14: Claimed for test-first implementation at the agreed Source Conversation lifecycle seam.
- 2026-07-14: RED locked missing lifecycle delete/project/discard behavior, source-owned facts and Skill Candidate cleanup, committed-shell protection, permanent/transient tombstone races, claim/delete ordering, and Project deletion races.
- 2026-07-14: Added a deep `SourceConversationLifecycle` seam for atomic run claims, empty-shell rollback, thread deletion, Project deletion, provenance cleanup, pi session cleanup, and non-fatal eligible scratch cleanup; HTTP adapters no longer know cleanup order.
- 2026-07-14: Validation passed: lint; build 11/11; typecheck 20/20; 4 targeted files / 50 tests; full Vitest 383 passed / 1 skipped. Standards and Spec reviews both passed.
