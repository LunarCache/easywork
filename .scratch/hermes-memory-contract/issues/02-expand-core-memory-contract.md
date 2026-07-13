# Expand the Core Memory contract

Status: done
Type: task
Blocked by: 01

## What to build

Introduce Agent Notes and the derived fact pool alongside the existing memory layer values so storage, APIs, and old clients remain green while the product moves away from `agent-memory` and `global.skills`.

## Acceptance criteria

- [x] The expanded contract accepts Agent Notes and explicit derived facts without breaking existing databases or clients.
- [x] Every write boundary enforces valid scope and layer combinations.
- [x] Always-on Core Memory and manifests are bounded independently from the derived pool.
- [x] Compatibility behavior is documented and covered by migration tests.

## Comments

- 2026-07-12: Completed shared/provider scope validation, independent curated/derived capacity, bounded manifests, migration coverage, and documentation.
