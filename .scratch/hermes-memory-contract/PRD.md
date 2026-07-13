# Memory and automatic Skill learning

Status: accepted

## Summary

EasyWork will separate factual memory from procedural Skills, remove the `global.skills` memory layer, preserve source provenance for automatically learned artifacts, and add an automatic learning loop that proposes reusable Skill packages for review. Background learning never activates or mutates a Skill without approval.

This contract applies to Chat, Workspace, and IM sessions that run through `SessionHost`. The OpenAI-compatible `/v1` gateway remains a direct inference surface and does not gain memory or Skill behavior.

## Goals

- Make it obvious whether persisted knowledge is a fact, a conversation archive entry, a workspace fact, or an executable Skill.
- Delete automatically extracted facts when their Source Conversation is deleted.
- Let users promote useful Extracted Facts into independent Curated Facts.
- Learn reusable procedures from successful tasks, user corrections, and recovered failures.
- Turn learned procedures into reviewable Skill Candidates rather than unreviewed active Skills.
- Keep automatic learning auditable, reversible, scoped, and safe from unrelated side effects.
- Keep local Core Memory available even when an external memory provider is enabled.

## Non-goals

- Training or fine-tuning model weights.
- Treating conversation history as long-term memory.
- Converting every long or tool-heavy task into a Skill.
- Automatically executing a newly generated Skill to test it against real external systems.
- Allowing the background reviewer to modify arbitrary files, run shell commands, browse the web, message users, or delegate work.
- Automatically modifying built-in, hub-installed, external, pinned, or user-authored Skills.

## Product model

| Artifact             | Purpose                                                  | Canonical source           | Scope               | Lifecycle                                   |
| -------------------- | -------------------------------------------------------- | -------------------------- | ------------------- | ------------------------------------------- |
| Conversation Archive | Full messages and tool history                           | Conversation SQLite + FTS5 | Conversation        | Deleted with the conversation               |
| User Profile         | Identity and durable user preferences                    | Memory SQLite              | Global              | Independent                                 |
| Agent Note           | Environment facts and concise cross-conversation lessons | Memory SQLite              | Global              | Independent                                 |
| Workspace Memory     | Conventions, decisions, and pitfalls                     | Memory SQLite              | Workspace           | Deleted with the workspace memory scope     |
| Extracted Fact       | Automatically derived factual knowledge                  | Memory SQLite              | Global or workspace | Owned by Source Conversation until promoted |
| Skill Candidate      | Proposed reusable procedure or Skill patch               | Candidate store            | Global or workspace | Source-owned until approved                 |
| Skill                | Approved executable procedural knowledge                 | `SKILL.md` package         | Global or workspace | Independent, versioned, archivable          |
| Deep Memory Provider | Optional semantic/user-model enhancement                 | Provider-owned             | Provider-defined    | Additive to local memory                    |

Markdown files are editable projections and import/export surfaces for memory; they are not the canonical store for provenance or lifecycle. `SKILL.md` and its package files remain canonical for active Skills because pi discovers Skills from the filesystem.

## Memory contract

### Layers

Global Core Memory contains:

- `user-profile` — User Profile facts.
- `agent-notes` — Agent Notes.

Workspace Memory contains:

- `conventions`.
- `decisions`.
- `pitfalls`.

The `global.skills` memory layer is removed. Procedures must become Skill Candidates or Skills; short heuristics belong in Agent Notes or workspace pitfalls.

### Origin and ownership

Memory origin is explicit rather than inferred from a nullable session ID:

- `manual` — directly entered by the user.
- `agent-managed` — deliberately written by the foreground agent through the memory tool.
- `extracted` — produced by the passive extraction pipeline.
- `imported` — imported from Markdown or a migration.
- `provider` — returned or mirrored by an optional external provider.

An `extracted` item has a `sourceThreadId` and remains owned by that Source Conversation. `manual` and `agent-managed` items are Curated Facts and have independent lifecycles.

Extraction alone does not place a fact in Core Memory. Extracted Facts remain in a provenance-bearing derived pool: they can be retrieved when relevant, but are presented with lower authority and a source label. Promotion moves the fact into Core Memory or Workspace Memory as a Curated Fact.

### Visibility and freshness

- Chat and IM can see global Core Memory.
- Workspace sessions can see their Workspace Memory plus the global User Profile.
- Workspace sessions do not automatically inherit global Agent Notes or unrelated global procedures.
- Memory writes persist immediately.
- The writing tool response shows live state immediately.
- Updated memory becomes available to the agent no later than its next turn.
- Always-on Core Memory and memory manifests are bounded; growth in the derived pool cannot create an unbounded prompt injection.
- Retrieval context is treated as untrusted persisted data, fenced from system instructions, and cannot override permissions, system policy, or project instructions.

### Deletion and promotion

Deleting a Source Conversation deletes:

- its messages and FTS entries;
- its persisted pi session state;
- its pending extraction buffer;
- every unpromoted Extracted Fact it owns;
- every unapproved single-source Skill Candidate it owns.

For a Skill Candidate with multiple Source Conversations, deletion removes the deleted source and its evidence; the candidate is deleted when no source remains.

Users can promote an Extracted Fact by confirming, editing, or pinning it. Promotion:

- changes it to a Curated Fact;
- removes source ownership;
- records who promoted it and when;
- makes it survive deletion of the original conversation.

## Automatic Skill learning

### What Hermes contributes

Hermes provides four useful patterns:

- The foreground agent can save a non-trivial workflow as procedural memory through `skill_manage` after successful complex work, corrections, or recovered failures.
- `/learn` turns a described workflow, current conversation, local source, or URL into a Skill through the normal agent and Skill tool path.
- A background self-improvement review periodically checks whether recent work should create or patch a Skill.
- A separate curator tracks usage, staleness, pinning, recoverable archival, backups, and optional consolidation.

EasyWork adopts these patterns with a stricter activation boundary: automatic review produces candidates, not active Skill writes.

Primary references:

- [Hermes Skills System](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/skills.md)
- [Hermes Curator](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/curator.md)
- [Hermes configuration and Skill write approval](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/configuration.md)
- [Hermes v0.12 self-improvement loop](https://github.com/NousResearch/hermes-agent/blob/main/RELEASE_v0.12.0.md)

### Learning signals

The learner may review a completed trajectory when one or more of these signals exist:

- a successful task required a non-trivial sequence of tools;
- an initial approach failed and a verified recovery path succeeded;
- the user corrected the agent's process;
- the agent discovered a reusable tool or environment workflow;
- the same or substantially similar procedure appears across multiple conversations;
- the user explicitly asks to remember, learn, or save the procedure as a Skill.

Tool-call count is a scheduling signal, not proof that a Skill is useful.

The learner must reject or defer a proposal when:

- the outcome was cancelled, failed, or not verified;
- the apparent lesson is a transient provider, network, permission, or environment failure;
- the content is a fact, preference, or project decision rather than a procedure;
- the procedure is already adequately covered by an existing Skill or project instruction;
- it contains secrets, tokens, private raw data, temporary paths, or raw logs;
- it encodes a one-off lucky path that cannot be generalized;
- it relies on unavailable tools without declaring the dependency.

`Nothing to learn` is a normal successful review result. The reviewer is not measured by how many candidates it produces.

### Class-first review

Before proposing a new Skill, Skill Review must:

1. Inspect the active Skill catalog by name, description, and trigger conditions.
2. Prefer a patch candidate for the Skill used in the task when the new lesson fills a real gap.
3. Prefer a broader existing class-level Skill over creating a narrow task-instance Skill.
4. Create a new Skill Candidate only when no existing Skill has appropriate ownership.
5. Keep facts, project decisions, and personality out of the Skill.

### Candidate contents

Every Skill Candidate contains:

- proposed name, description, trigger conditions, scope, and version;
- proposed `SKILL.md` or a unified diff against an existing Skill;
- required tools and platforms;
- generalized procedure, pitfalls, and verification steps;
- referenced scripts, templates, assets, or examples, if any;
- source conversation IDs and minimal evidence summaries;
- reason for creation or patching;
- learner model/provider and timestamp;
- validation results and security findings;
- status: `pending`, `approved`, `rejected`, or `superseded`.

Raw conversation transcripts are not copied into the candidate.

### Review and activation

Automatic learning is enabled by default, but automatic activation is not.

- Background review may create or update pending Skill Candidates.
- The reviewer can only list/view Skills and stage candidate packages or diffs.
- The reviewer has no shell, arbitrary filesystem, network, messaging, delegation, MCP, or external side-effect tools.
- Candidate writes are confined to the pending store.
- Approval is always explicit for automatically generated candidates.
- Rejection records an optional reason so equivalent bad candidates can be suppressed later.
- Approval performs validation again, writes the package atomically, records provenance, and invalidates affected AgentSessions so the Skill is discoverable on the next run.

An explicit user command such as `/learn how I just deployed staging` follows the foreground agent path, but still stages a candidate and shows the diff before activation. A future expert setting may allow direct activation for explicit `/learn`; it is not part of the default contract.

### Scope

- Candidates learned in ordinary Chat or IM default to global scope and target `~/.easywork/pi-agent/skills/<slug>/`.
- Candidates learned in a Workspace default to workspace scope and target the workspace's trusted project Skill source, normally `.agents/skills/<slug>/`.
- The user can change scope before approval.
- A workspace candidate may not write outside its workspace, including through symlinks.

### Validation

Approval requires:

- valid Skill frontmatter and a collision-safe slug;
- required description and trigger conditions;
- referenced package files to exist and remain inside the package;
- no absolute or parent-traversal resource references unless explicitly accepted as a local dependency;
- declared tools to exist or be marked optional;
- secret, credential, prompt-injection, exfiltration, and invisible-Unicode scanning;
- no instructions that attempt to override system policy, approval, or workspace confinement;
- a verification section describing how success is checked;
- a diff preview for patches and updates;
- an optimistic version or content-hash check proving the reviewed Skill has not changed since the candidate was generated.

Validation does not automatically execute real side effects. Optional sandboxed tests may be added later for Skills whose verification is demonstrably safe.

## Skill lifecycle

Approved learned Skills record provenance and usage telemetry:

- `createdBy`: user, foreground-agent, or background-learning.
- creation and last-update timestamps.
- use, view, failure, correction, and patch counts.
- last-used timestamp.
- state: `active`, `stale`, or `archived`.
- pinned state.

After a learned Skill is used:

- successful use increments usage;
- a user correction or verified failure can create a patch candidate;
- the active Skill is not changed until that patch candidate is approved.

Lifecycle maintenance:

- may mark unused learned Skills stale;
- may recommend merging overlaps;
- may archive learned Skills after review;
- never auto-deletes a Skill;
- never mutates or archives pinned, built-in, external, hub-installed, or user-authored Skills;
- creates a recoverable snapshot before applying a maintenance batch;
- emits a human-readable report and supports rollback.

LLM-driven consolidation is opt-in and always produces reviewable diffs.

## UI contract

### Memory settings

- Remove the `技能` memory section.
- Show User Profile, Agent Notes, and workspace-specific sections.
- Replace the current inferred `自动/手动` badge with explicit origin labels.
- Show Source Conversation for Extracted Facts.
- Add `确认并保留` for promotion.
- Warn that deleting the Source Conversation will delete unpromoted Extracted Facts.

### Skills settings

The Skills page adds:

- `已启用` — active discovered Skills.
- `待审核` — Skill Candidates and proposed patches.
- `已归档` — recoverable learned Skills.

Candidate detail shows:

- why it was learned;
- global/workspace scope;
- evidence summaries and source links;
- complete `SKILL.md` preview or unified diff;
- security and validation results;
- approve, revise, reject, and change-scope actions.

The page also adds `学习 Skill`, which starts an explicit `/learn` flow from free text, a local path, a URL, or the current conversation.

Settings include:

- automatic Skill learning on/off, default on;
- review frequency or automatic scheduling, with a manual `立即检查` action;
- auxiliary learner model, default Auto/current chat model;
- LLM consolidation on/off, default off.

## API and storage requirements

The implementation must provide product-level operations equivalent to:

- list/get/create/revise/approve/reject Skill Candidates;
- promote an Extracted Fact;
- list active/stale/archived learned Skills;
- pin/unpin/archive/restore learned Skills;
- retrieve validation reports and candidate diffs;
- trigger a background review or dry run;
- inspect learning status and last run.

Candidate and provenance state belongs in SQLite or another structured local store. Active Skill packages remain filesystem-native.

## Migration

### Memory schema

- Replace implicit `sessionId` origin detection with explicit origin, lifecycle state, and `sourceThreadId`.
- Rename the product concept `agent-memory` to Agent Notes; storage migration may retain a compatibility value temporarily.
- Enforce valid scope/layer combinations at every write boundary.
- Enforce capacity and security rules consistently for UI, agent-managed, imported, and extracted writes.

### Existing `global.skills`

Existing entries are never activated directly.

- Source-owned entries become pending Skill Candidates when procedural, or Extracted Facts/Agent Notes when factual.
- Independent entries become pending candidates or Agent Notes after classification.
- Ambiguous entries remain in a read-only legacy view until reviewed.
- Preserve the original `skills.md` as a migration backup; stop injecting it after migration.

### Session behavior

- Approved memory changes are visible no later than the next turn.
- Approved Skill changes invalidate affected cached AgentSessions and are visible on the next run.
- `/v1` behavior remains unchanged.

## Delivery slices

1. Memory terminology, schema provenance, promotion, deletion, and `global.skills` migration.
2. Skill Candidate store, restricted reviewer, validation, approval APIs, and Skills UI review surface.
3. Explicit `/learn` flow for conversation, text, local path, and URL inputs.
4. Background scheduling, class-first learning, source deletion handling, and notifications.
5. Usage telemetry, patch candidates, stale/archive/pin/restore, snapshots, reports, and rollback.
6. Optional additive deep-memory providers and optional LLM consolidation.

## Acceptance criteria

- Deleting a conversation removes all unpromoted Extracted Facts owned solely by that conversation.
- Promoted Curated Facts survive source deletion.
- No active memory layer or UI label named `skills` remains.
- A completed reusable workflow can produce a pending Skill Candidate without changing the active Skill catalog.
- A background reviewer cannot invoke non-Skill side-effect tools.
- A candidate cannot activate without explicit approval.
- Approved global and workspace Skills are discovered by pi on the next run.
- Candidate approval is rejected on path escape, invalid frontmatter, missing references, secrets, or instruction-injection findings.
- Existing built-in, external, hub-installed, pinned, and user-authored Skills cannot be changed by background learning.
- Deleting an unapproved candidate's last Source Conversation deletes that candidate.
- Learned Skill changes are diffable and recoverable.
- Memory continues to work when an external provider is disabled, unavailable, or removed.
