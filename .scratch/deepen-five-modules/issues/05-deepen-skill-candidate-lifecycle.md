# Deepen the Skill Candidate lifecycle module

Status: done
Type: task
Blocked by: 04

## Question

How can Skill Candidate, Skill Review, and Learned Skill state transitions become one deep lifecycle module while preserving ADR-0002, atomic package activation, provenance, and recoverability?

## Acceptance criteria

- [x] A failing lifecycle test first spans Candidate creation, Skill Review, approval, and Learned Skill state through one interface using local store/filesystem and reviewer mock adapters.
- [x] Review eligibility, reviewer policy, validation, provenance, approval, telemetry, pinning, archive, snapshot, restore, rollback, and curation are owned by the lifecycle module.
- [x] HTTP routes, Agent tools, background learning, and startup migration cannot directly access the candidate store.
- [x] SQLite/filesystem and reviewer remain internal adapters.
- [x] Background learning still creates only pending Skill Candidates and never activates automatically.
- [x] Old casts that fake a partial SkillCandidateService interface are removed.
- [x] Skill learning, server route, and UI contract tests pass.
- [x] Code review passes and the change is committed independently.

## Comments

- 2026-07-14: Claimed for test-first implementation at the Skill Candidate lifecycle seam.
- 2026-07-14: Completed with one lifecycle owning local persistence, restricted review policy, Candidate approval, Learned Skill recovery, telemetry, and shutdown draining. Standards and Spec reviews passed with no remaining findings; lint, typecheck, build, 384 tests, and 39 UI E2E tests passed.
