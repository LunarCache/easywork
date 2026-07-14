# Deepen the Workbench View Session module

Status: open
Type: task
Blocked by: 02

## Question

How can opening, activating, closing, restoring, and view-specific lifecycle rules move behind one Workbench View Session seam while SideDock remains a rendering module and current restoration behavior stays unchanged?

## Acceptance criteria

- [ ] A failing state-level test first locks Workbench View Session behavior using local adapters.
- [ ] Open view state, active view selection, close fallback, restore behavior, and terminal close confirmation live behind one module interface.
- [ ] File, browser, terminal, and diff behavior act as internal adapters rather than conditionals spread through SideDock.
- [ ] SideDock's caller interface no longer leaks avoidable view lifecycle knowledge.
- [ ] Terminal reattachment survives hide/tab/WebView reload exactly as before; ordinary file/browser sessions gain no new app-restart persistence.
- [ ] Navigation Playwright and Rust PTY tests pass.
- [ ] Computer Use covers terminal confirmation and HTML/browser/file tab behavior.
- [ ] Code review passes and the change is committed independently.

## Comments
