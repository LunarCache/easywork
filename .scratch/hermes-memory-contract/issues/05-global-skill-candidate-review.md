# Review and activate global Skill Candidates

Status: done
Type: task
Blocked by: 01

## What to build

Let EasyWork stage a global Skill Candidate, show its evidence and complete `SKILL.md` or diff, validate it, and require explicit approval before atomically activating it in the global pi Skill directory.

## Acceptance criteria

- [x] Candidate storage records status, scope, provenance, source conversations, model, evidence summary, proposed package, and validation report.
- [x] Skills settings expose pending candidate list/detail plus approve, revise, reject, and change-scope actions.
- [x] Approval validates frontmatter, path confinement, references, declared tools, secrets, prompt injection, and optimistic content hash.
- [x] Approval atomically writes the Skill and invalidates affected AgentSessions; rejection never changes the active catalog.
- [x] Automatically generated candidates cannot bypass approval.

## Comments

- 2026-07-12: Completed structured storage, full-package diff/review, security validation, atomic approval, state-machine hardening, and session invalidation.
