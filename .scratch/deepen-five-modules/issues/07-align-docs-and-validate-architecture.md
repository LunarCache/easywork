# Align documentation and validate the completed architecture

Status: done
Type: task
Blocked by: 02, 03, 04, 05, 06

## Question

How do we prove all five deep modules are complete, compatible, documented, and cleanly integrated across supported surfaces?

## Acceptance criteria

- [x] `CONTEXT.md` contains only the confirmed implementation-free glossary terms.
- [x] README, AGENTS, FEATURES, ARCHITECTURE, DESIGN, PROGRESS, and generated design-web output are aligned where affected.
- [x] Deleted shallow modules/tests are absent and no compatibility bridge is left without a documented removal reason.
- [x] `git diff --check`, lint, typecheck, build, Vitest, Playwright, Rust check/test, and relevant packaging smoke pass.
- [x] Computer Use validates Chat, Workspace, Workbench terminal, file/HTML browser behavior, and provider settings smoke paths.
- [x] A final code review covers the full five-commit range along Standards and Spec axes.
- [x] The final docs/validation change is committed and the worktree is clean.

## Comments

- 2026-07-14: Claimed for final documentation alignment, full supported-surface validation, Computer Use smoke coverage, and five-commit Standards/Spec review.
- 2026-07-14: Full validation passed: 391 Vitest tests (1 skipped), 39 Playwright tests, lint, typecheck, build, Rust check/test, release version check, macOS arm64 SEA build, and packaged daemon `/health` smoke.
- 2026-07-14: Computer Use passed across Chat, Workspace, top-level closable workbench tabs, direct HTML Browser rendering, custom-address normalization, real PTY input/output, and cloud Provider settings.
- 2026-07-14: Final full-range review completed with Standards 0 findings and Spec 0 findings after correcting the Workbench View Session glossary scope and removing an inaccurate cross-store transaction claim from PROGRESS.
- 2026-07-14: Completed by the final documentation and validation commit; no compatibility bridge or uncommitted task change remains.
