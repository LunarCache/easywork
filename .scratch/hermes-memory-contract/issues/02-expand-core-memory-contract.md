# Expand the Core Memory contract

Status: ready-for-agent
Type: task
Blocked by: 01

## What to build

Introduce Agent Notes and the derived fact pool alongside the existing memory layer values so storage, APIs, and old clients remain green while the product moves away from `agent-memory` and `global.skills`.

## Acceptance criteria

- [ ] The expanded contract accepts Agent Notes and explicit derived facts without breaking existing databases or clients.
- [ ] Every write boundary enforces valid scope and layer combinations.
- [ ] Always-on Core Memory and manifests are bounded independently from the derived pool.
- [ ] Compatibility behavior is documented and covered by migration tests.

## Comments
