# Reserve macOS traffic-light safe area in maximized SideDock

Status: done

## Goal

Prevent the maximized right workbench header from rendering file, browser, terminal, or diff titles underneath the native macOS traffic-light controls.

## Acceptance criteria

- [x] Maximized SideDock keeps its header below or to the right of the macOS traffic-light safe area.
- [x] The adjustment applies at the shared SideDock host rather than per file/browser view.
- [x] Browser mode and non-maximized SideDock geometry remain unchanged.
- [x] A Playwright regression reproduces the Tauri/macOS overlap and passes after the fix.
- [x] Typecheck, lint, build, and relevant E2E pass.

## Comments

- 2026-07-13: Reported after maximizing file and browser views in the right workbench.
- 2026-07-13: Reproduced at the shared SideDock seam: the file title started at x=40 inside the native control region. Centralized the existing 88px safe-area value and applied it only to desktop maximized headers; targeted navigation tests and all 27 UI E2E tests pass.
