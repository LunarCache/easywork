# Skill use feedback and patch candidates

Status: ready-for-agent
Type: task
Blocked by: 08

## What to build

Track how learned Skills perform and turn verified failures, corrections, or missing steps into reviewable patch candidates instead of silently mutating active Skills.

## Acceptance criteria

- [ ] Learned Skills record view, use, success, failure, correction, and patch activity.
- [ ] A correction or verified Skill failure can stage a patch candidate tied to the Skill version and source trajectory.
- [ ] Stale patch candidates fail optimistic locking and must be regenerated or revised.
- [ ] Built-in, external, hub-installed, pinned, and user-authored Skills remain outside automatic mutation ownership.
- [ ] Skills settings show provenance and usage health without bloating the runtime catalog.

## Comments
