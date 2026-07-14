# Align documentation and validate the completed architecture

Status: open
Type: task
Blocked by: 02, 03, 04, 05, 06

## Question

How do we prove all five deep modules are complete, compatible, documented, and cleanly integrated across supported surfaces?

## Acceptance criteria

- [ ] `CONTEXT.md` contains only the confirmed implementation-free glossary terms.
- [ ] README, AGENTS, FEATURES, ARCHITECTURE, DESIGN, PROGRESS, and generated design-web output are aligned where affected.
- [ ] Deleted shallow modules/tests are absent and no compatibility bridge is left without a documented removal reason.
- [ ] `git diff --check`, lint, typecheck, build, Vitest, Playwright, Rust check/test, and relevant packaging smoke pass.
- [ ] Computer Use validates Chat, Workspace, Workbench terminal, file/HTML browser behavior, and provider settings smoke paths.
- [ ] A final code review covers the full five-commit range along Standards and Spec axes.
- [ ] The final docs/validation change is committed and the worktree is clean.

## Comments
