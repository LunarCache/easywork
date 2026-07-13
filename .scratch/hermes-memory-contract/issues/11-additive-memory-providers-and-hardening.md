# Make deep memory additive and finish hardening

Status: ready-for-agent
Type: task
Blocked by: 04, 10

## What to build

Make optional deep-memory providers enhance rather than replace local Core Memory, finish memory-to-prompt threat handling, and validate the complete memory and Skill learning contract across Chat, Workspace, and IM.

## Acceptance criteria

- [ ] Local Core Memory continues to work when an external provider is enabled, unavailable, disabled, or removed.
- [ ] Provider recall is fenced, attributed, bounded, and scanned before model context injection.
- [ ] Memory and Skill learning remain absent from the direct `/v1` inference path.
- [ ] End-to-end tests cover Chat, Workspace, source deletion, candidate approval, Skill discovery, and external-provider failure.
- [ ] All product, architecture, progress, and generated design documentation matches the implemented behavior.

## Comments
