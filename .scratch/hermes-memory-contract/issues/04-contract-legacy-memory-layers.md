# Contract legacy memory layers

Status: done
Type: task
Blocked by: 03

## What to build

Remove compatibility paths for `agent-memory` and memory-layer `skills` after all persisted data and callers have moved to the accepted Core Memory contract.

## Acceptance criteria

- [x] Shared contracts, APIs, prompts, UI, and tests use only the accepted memory vocabulary.
- [x] Startup migration is idempotent and leaves no active legacy-layer rows.
- [x] Documentation and generated design HTML describe the implemented contract.
- [x] Full build, test, lint, typecheck, and UI e2e suites pass.

## Comments

- 2026-07-12: Removed active legacy values, documented the final vocabulary, regenerated design HTML, and passed the full validation gate.
