# Polish learning and memory frontend

Status: done

## Goal

Restore a clear settings hierarchy for the newly added Skill-learning and memory-management surfaces without changing their product contract.

## Acceptance criteria

- [x] The Skills page keeps navigation and primary actions separate from automatic-learning configuration.
- [x] Automatic-learning settings remain discoverable but no longer force labels and inputs into a single overflowing row.
- [x] Skills settings have no horizontal overflow at a 1280px desktop viewport.
- [x] Memory runtime status remains visible without competing with search and the primary Add action.
- [x] The legacy Skills migration audit is visually secondary and compact when it has no pending items.
- [x] Existing learning, migration, provider, feedback, and snapshot interactions remain functional.
- [x] Typecheck, lint, targeted Playwright, visual QA, Standards review, and Spec review pass.

## Comments

- 2026-07-13: Started from Desktop screenshots showing severe wrapping in the Skill-learning control row and excessive emphasis on an empty legacy migration panel.
- 2026-07-13: Completed the shared disclosure interaction, responsive automatic-learning settings, compact memory runtime status, and secondary migration audit. Verified in light and dark themes; 343 Vitest passed / 1 skipped, 26 Playwright passed, full build/typecheck/lint passed, and both review axes finished with 0 residual findings.
