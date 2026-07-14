# Deepen the Skill Candidate lifecycle module

Status: open
Type: task
Blocked by: 04

## Question

How can Skill Candidate, Skill Review, and Learned Skill state transitions become one deep lifecycle module while preserving ADR-0002, atomic package activation, provenance, and recoverability?

## Acceptance criteria

- [ ] A failing lifecycle test first spans Candidate creation, Skill Review, approval, and Learned Skill state through one interface using local store/filesystem and reviewer mock adapters.
- [ ] Review eligibility, reviewer policy, validation, provenance, approval, telemetry, pinning, archive, snapshot, restore, rollback, and curation are owned by the lifecycle module.
- [ ] HTTP routes, Agent tools, background learning, and startup migration cannot directly access the candidate store.
- [ ] SQLite/filesystem and reviewer remain internal adapters.
- [ ] Background learning still creates only pending Skill Candidates and never activates automatically.
- [ ] Old casts that fake a partial SkillCandidateService interface are removed.
- [ ] Skill learning, server route, and UI contract tests pass.
- [ ] Code review passes and the change is committed independently.

## Comments
