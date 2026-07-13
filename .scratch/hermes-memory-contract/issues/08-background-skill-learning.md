# Restricted background Skill learning

Status: done
Type: task
Blocked by: 07

## What to build

Review successful trajectories after the main response, identify genuinely reusable procedures, and stage class-first Skill Candidates without writing the conversation or reviewer activity into the user thread.

## Acceptance criteria

- [x] Scheduling uses meaningful successful-work signals; tool count is only a trigger and `Nothing to learn` is a valid result.
- [x] Review prefers the loaded Skill, then an existing umbrella Skill, then support files, and creates a new umbrella only as a last resort.
- [x] Cancelled, failed, transient, secret-bearing, and one-off trajectories do not produce candidates.
- [x] The reviewer receives a read-only trajectory snapshot and only Skill list/view plus candidate-staging capabilities.
- [x] Shell, arbitrary filesystem, network, MCP, messaging, delegation, and other side effects are unavailable.
- [x] Background failures are observable but never fail the user's main turn.

## Comments

- 2026-07-12: Completed restricted Chat/Workspace/IM scheduling, trusted trajectory provenance, bounded class-first package context, safe skips, and observable status.
