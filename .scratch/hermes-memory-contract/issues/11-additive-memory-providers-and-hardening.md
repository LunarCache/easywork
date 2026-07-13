# Make deep memory additive and finish hardening

Status: done
Type: task
Blocked by: 04, 10

## What to build

Make optional deep-memory providers enhance rather than replace local Core Memory, finish memory-to-prompt threat handling, and validate the complete memory and Skill learning contract across Chat, Workspace, and IM.

## Acceptance criteria

- [x] Local Core Memory continues to work when an external provider is enabled, unavailable, disabled, or removed.
- [x] Provider recall is fenced, attributed, bounded, and scanned before model context injection.
- [x] Memory and Skill learning remain absent from the direct `/v1` inference path.
- [x] End-to-end tests cover Chat, Workspace, source deletion, candidate approval, Skill discovery, and external-provider failure.
- [x] All product, architecture, progress, and generated design documentation matches the implemented behavior.

## Comments

- 2026-07-12: Completed additive read-only provider fallback, local/provider fencing and attribution, `/v1` isolation, cross-surface tests, and documentation alignment.
