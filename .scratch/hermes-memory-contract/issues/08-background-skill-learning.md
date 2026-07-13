# Restricted background Skill learning

Status: ready-for-agent
Type: task
Blocked by: 07

## What to build

Review successful trajectories after the main response, identify genuinely reusable procedures, and stage class-first Skill Candidates without writing the conversation or reviewer activity into the user thread.

## Acceptance criteria

- [ ] Scheduling uses meaningful successful-work signals; tool count is only a trigger and `Nothing to learn` is a valid result.
- [ ] Review prefers the loaded Skill, then an existing umbrella Skill, then support files, and creates a new umbrella only as a last resort.
- [ ] Cancelled, failed, transient, secret-bearing, and one-off trajectories do not produce candidates.
- [ ] The reviewer receives a read-only trajectory snapshot and only Skill list/view plus candidate-staging capabilities.
- [ ] Shell, arbitrary filesystem, network, MCP, messaging, delegation, and other side effects are unavailable.
- [ ] Background failures are observable but never fail the user's main turn.

## Comments
