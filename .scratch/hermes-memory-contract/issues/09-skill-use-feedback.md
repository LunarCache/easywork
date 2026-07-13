# Skill use feedback and patch candidates

Status: done
Type: task
Blocked by: 08

## What to build

Track how learned Skills perform and turn verified failures, corrections, or missing steps into reviewable patch candidates instead of silently mutating active Skills.

## Acceptance criteria

- [x] Learned Skills record view, use, success, failure, correction, and patch activity.
- [x] A correction or verified Skill failure can stage a patch candidate tied to the Skill version and source trajectory.
- [x] Stale patch candidates fail optimistic locking and must be regenerated or revised.
- [x] Built-in, external, hub-installed, pinned, and user-authored Skills remain outside automatic mutation ownership.
- [x] Skills settings show provenance and usage health without bloating the runtime catalog.

## Comments

- 2026-07-12: Completed successful-use tracking, outcome telemetry, source-linked patch candidates, package-wide locking, ownership guards, and Skills health UI.
