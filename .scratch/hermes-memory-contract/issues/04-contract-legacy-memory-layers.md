# Contract legacy memory layers

Status: ready-for-agent
Type: task
Blocked by: 03

## What to build

Remove compatibility paths for `agent-memory` and memory-layer `skills` after all persisted data and callers have moved to the accepted Core Memory contract.

## Acceptance criteria

- [ ] Shared contracts, APIs, prompts, UI, and tests use only the accepted memory vocabulary.
- [ ] Startup migration is idempotent and leaves no active legacy-layer rows.
- [ ] Documentation and generated design HTML describe the implemented contract.
- [ ] Full build, test, lint, typecheck, and UI e2e suites pass.

## Comments
