# Deepen five EasyWork modules

Status: resolved
Type: wayfinder:map

## Destination

Deepen the Agent Turn UI, Workbench View Session, Source Conversation lifecycle, Skill Candidate lifecycle, and Provider Model Configuration modules without changing external behavior or compatibility. Each change lands as an independently verified commit; the effort ends with aligned domain and architecture documentation, full automated validation, and Computer Use smoke coverage.

## Notes

- This map explicitly carries execution, not only planning.
- Work tickets are AFK tasks and run sequentially in the agreed order.
- Use `codebase-design` vocabulary and the deletion test throughout.
- Use `tdd` at the agreed module interface; replace shallow tests rather than layering more tests over them.
- Use `domain-modeling` whenever glossary terms sharpen; keep `CONTEXT.md` implementation-free.
- Finish each implementation ticket with `code-review` and an independent local commit.
- Preserve existing HTTP/SDK, Tauri IPC, SQLite data, user interaction, and cross-platform behavior.

## Decisions so far

- [Confirm the five-module deepening contract](issues/01-confirm-deepening-contract.md) — behavior-compatible scope, module ownership, test strategy, sequence, and domain terms are agreed.
- [Deepen the Agent Turn UI](issues/02-deepen-agent-turn-ui.md) — `AgentTurnController` now owns the complete client turn lifecycle while Chat and Workspace only supply policy and presentation.
- [Deepen the Workbench View Session](issues/03-deepen-workbench-view-session.md) — one module now owns open views, active selection, close fallback, terminal restoration, and file/browser navigation through internal adapters.
- [Deepen the Source Conversation lifecycle](issues/04-deepen-source-conversation-lifecycle.md) — run claims, deletion barriers, source-owned cleanup, Project reuse, and non-fatal scratch removal now live behind one lifecycle interface.
- [Deepen the Skill Candidate lifecycle](issues/05-deepen-skill-candidate-lifecycle.md) — Candidate review, validation, approval, provenance, telemetry, archive, snapshots, restore, and rollback now share one guarded state interface.
- [Deepen Provider Model Configuration](issues/06-deepen-provider-model-configuration.md) — Core now solely owns route identity, catalog inheritance, runtime model construction, projections, and protocol compatibility.
- [Align documentation and validate the completed architecture](issues/07-align-docs-and-validate-architecture.md) — documentation, generated design output, automated/Rust/packaging checks, Computer Use smoke coverage, and final Standards/Spec review all passed.

## Not yet specified

- None. Exact internal interfaces are discovered test-first inside each implementation ticket, within the agreed seam and compatibility constraints.

## Out of scope

- New user-facing features or visual redesign.
- Breaking HTTP/SDK, Tauri IPC, persisted SQLite, or saved provider configuration compatibility.
- New cross-application persistence for ordinary Workbench View Sessions.
- Deleting or moving user workspace directories.
- Reopening ADR-0001 or ADR-0002.
