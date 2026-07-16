# EasyWork

EasyWork is a local AI workbench that hosts a persistent agent across chat, workspace, and channel surfaces.

## Language

**Core Memory**:
A bounded set of cross-conversation facts that EasyWork should keep readily available. It consists of the User Profile and Agent Notes.
_Avoid_: global skills, conversation history

**User Profile**:
Curated facts about the user's identity, durable preferences, communication style, and expectations.
_Avoid_: user memory, account profile

**Agent Note**:
Curated cross-conversation facts about the user's environment and concise lessons the agent should retain.
_Avoid_: agent memory, skill, procedure

**Workspace Memory**:
Durable knowledge isolated to one workspace, including its conventions, decisions, and pitfalls.
_Avoid_: global memory, project history

**Extracted Fact**:
A fact automatically derived from exactly one Source Conversation and owned by it for lifecycle purposes. It may be recalled with its provenance but does not enter Core Memory unless promoted to a Curated Fact.
_Avoid_: permanent memory, manual memory

**Curated Fact**:
A fact explicitly added, confirmed, or promoted into long-term memory. It has an independent lifecycle and does not belong to a Source Conversation.
_Avoid_: extracted fact, permanent fact

**Source Conversation**:
The conversation recorded as provenance for an Extracted Fact or Skill Candidate. Deleting it removes artifacts it solely owns and removes its evidence from multi-source candidates; once deletion starts, a concurrent Agent Turn cannot revive it, while a later submission may create a new Source Conversation.
_Avoid_: memory scope, workspace

**Agent Turn**:
A bounded interaction that starts with one user submission and ends with a final result, cancellation, or error. It has one canonical trajectory across entry surfaces and may include reasoning, tool activity, approvals, usage, and artifacts; an accepted external submission may remain durable when the turn fails, while agent-produced results require successful completion. Delivery of a completed result to an external channel is a separate outcome and does not change the turn's result.
_Avoid_: conversation, message, agent session

**Workbench View Session**:
The lifecycle of the open-view set and its active view within one workbench scope, including creation, switching, hiding, restoration, and close fallback. Different view kinds may have different restoration rules.
_Avoid_: dock tab, panel, window

**Provider Model Configuration**:
The provider-scoped description of a model's identity, capabilities, and protocol behavior that authoritatively determines its runtime model.
_Avoid_: model preference, catalog entry, runtime model

**Skill Candidate**:
A proposed reusable procedure learned from one or more completed tasks. It is not discoverable or executable as a Skill until it passes review and is approved.
_Avoid_: draft memory, global skill

**Skill**:
An approved, discoverable procedure that teaches the agent how to perform a recurring class of work and may include instructions, scripts, references, templates, or assets.
_Avoid_: memory, tip, fact

**Skill Review**:
The review that compares a Skill Candidate or proposed Skill change with existing Skills and decides whether to reject, revise, merge, or approve it.
_Avoid_: memory extraction, automatic install

**Learned Skill**:
An approved Skill created through EasyWork's Candidate pipeline. EasyWork may record its usage, propose version-locked patches, pin it, mark it stale, or archive it recoverably; approval is still required for content changes.
_Avoid_: user-authored Skill, automatically installed Skill

**Additive Memory Provider**:
An optional untrusted recall source that can supplement local Core Memory but cannot receive or own EasyWork memory writes. Its absence or failure must not change local behavior.
_Avoid_: primary memory backend, memory replacement
