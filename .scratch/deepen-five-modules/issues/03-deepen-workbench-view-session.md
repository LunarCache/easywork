# Deepen the Workbench View Session module

Status: done
Type: task
Blocked by: 02

## Question

How can opening, activating, closing, restoring, and view-specific lifecycle rules move behind one Workbench View Session seam while SideDock remains a rendering module and current restoration behavior stays unchanged?

## Acceptance criteria

- [x] A failing state-level test first locks Workbench View Session behavior using local adapters.
- [x] Open view state, active view selection, close fallback, restore behavior, and terminal close confirmation live behind one module interface.
- [x] File, browser, terminal, and diff behavior act as internal adapters rather than conditionals spread through SideDock.
- [x] SideDock's caller interface no longer leaks avoidable view lifecycle knowledge.
- [x] Terminal reattachment survives hide/tab/WebView reload exactly as before; ordinary file/browser sessions gain no new app-restart persistence.
- [x] Navigation Playwright and Rust PTY tests pass.
- [x] Computer Use covers terminal confirmation and HTML/browser/file tab behavior.
- [x] Code review passes and the change is committed independently.

## Comments

- 2026-07-14: Claimed for test-first implementation at the agreed Workbench View Session state seam.
- 2026-07-14: Implemented a framework-independent `WorkbenchViewSession` plus React/daemon adapters; SideDock now consumes a discriminated view state and renders layout only.
- 2026-07-14: File selection/reconcile, HTML and URL navigation, close fallback, empty-session restore, runtime terminal restore, and foreground-process close confirmation now live behind the session interface; ordinary views remain in memory only.
- 2026-07-14: Verified root lint, 20 typecheck tasks, 371 Vitest tests (1 skipped), 12 navigation Playwright tests, and 3 Rust PTY tests. Computer Use confirmed cancel-safe foreground terminal close plus HTML/browser/custom-address/file behavior. Standards and Spec reviews both pass after resolving all findings.
