# Confirm the five-module deepening contract

Status: resolved
Type: grilling

## Question

What destination, sequence, ownership seams, compatibility rules, test strategy, and domain language govern the five-module architecture effort?

## Answer

- Completion is a behavior-compatible internal deepening: existing HTTP/SDK, Tauri IPC, SQLite data, user interaction, and cross-platform behavior remain compatible.
- Execute in order: Agent Turn UI; Workbench View Session; Source Conversation lifecycle; Skill Candidate lifecycle; Provider Model Configuration.
- Agent Turn UI owns the full client turn lifecycle; Chat and Workspace supply only their policies and presentation needs.
- Workbench View Session owns tab state and lifecycle; SideDock remains layout/rendering; view-specific behavior stays behind internal adapters; current restoration behavior is preserved.
- Source Conversation lifecycle owns the deletion barrier and all source-owned cleanup. User workspace directories are never deleted; scratch artifact cleanup remains non-fatal.
- Skill Candidate lifecycle owns review eligibility, reviewer policy, validation, provenance, approval, telemetry, archive, snapshot, and rollback; stores and reviewers are internal adapters; ADR-0002 remains binding.
- Provider Model Configuration has one semantic owner in Core; UI edits projections and does not independently decide runtime identity or capabilities.
- Tests use replace-don't-layer: each deep module interface is the test surface, old shallow tests are deleted after replacement coverage exists, and no production interface is added solely for tests.
- Three glossary terms are canonical: Agent Turn, Workbench View Session, and Provider Model Configuration.

## Comments

- 2026-07-14: Resolved through the required one-question-at-a-time grilling loop with explicit user confirmation of every decision.
