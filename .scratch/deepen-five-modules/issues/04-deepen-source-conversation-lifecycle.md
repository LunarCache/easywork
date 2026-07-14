# Deepen the Source Conversation lifecycle module

Status: open
Type: task
Blocked by: 03

## Question

How can all Source Conversation ownership and deletion behavior move behind one lifecycle seam without weakening the run barrier, provenance rules, failure reporting, or user workspace safety?

## Acceptance criteria

- [ ] A failing integration test first locks deletion outcomes through the lifecycle interface with in-memory SQLite and temporary storage adapters.
- [ ] The module owns the run/deletion barrier, extraction discard, Extracted Fact deletion, Skill Candidate source removal, Conversation/FTS deletion, pi session cleanup, and eligible scratch artifact cleanup.
- [ ] Thread and Project deletion adapters no longer know the cleanup ordering.
- [ ] Project deletion reuses the same Source Conversation lifecycle rather than repeating the sequence.
- [ ] User workspace directories are never removed.
- [ ] Scratch artifact deletion remains non-fatal; ownership cleanup failures remain observable as deletion failures.
- [ ] ADR-0001 semantics remain unchanged.
- [ ] Core targeted tests and route contract tests pass.
- [ ] Code review passes and the change is committed independently.

## Comments
