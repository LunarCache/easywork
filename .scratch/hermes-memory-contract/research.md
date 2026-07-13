# Hermes Agent memory mechanism

Research date: 2026-07-12

## Question

What is Hermes Agent's current memory contract, and which parts are useful when sharpening EasyWork's product contract?

## Current Hermes contract

Hermes separates four concerns that are easy to conflate:

1. **Bounded core memory**: `~/.hermes/memories/MEMORY.md` stores agent notes, environment facts, conventions, and learned lessons (2,200 characters). `USER.md` stores user identity, preferences, and communication style (1,375 characters).
2. **Conversation archive**: full sessions are stored in `~/.hermes/state.db`; `session_search` retrieves actual messages through SQLite FTS5 without an LLM summary.
3. **Skills**: procedures and reusable workflows are separate artifacts. Hermes describes memory as "what" and skills as "how".
4. **Optional deep memory**: one external memory provider may be enabled, but it is additive; the built-in files remain active.

The built-in memory snapshot is loaded once at session start and remains frozen for that session. Writes are persisted immediately and visible in tool results, but they do not alter the active system prompt until a later session. This preserves prompt-prefix caching.

The memory tool supports `add`, `replace`, and `remove`; replace/remove use a unique substring. There is no read action because the entire bounded snapshot is already in context. Capacity overflow returns an error so the agent must consolidate or remove entries. Exact duplicates are rejected.

Hermes prompts the agent to save durable information proactively, but the two built-in files are curated stores, not a semantic extraction database. External providers can add per-turn prefetch, turn synchronization, session-end extraction, semantic search, and provider-specific tools.

Memory entries are scanned for injection, exfiltration, invisible Unicode, and related threat patterns before they are accepted or injected.

## Comparison with EasyWork

| Concern              | Hermes                                                               | EasyWork today                                                                  | Contract implication                                                                     |
| -------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Global memory        | Two small full-text stores                                           | Three layers: `user-profile`, `agent-memory`, `skills`                          | `global.skills` conflicts with runtime Skill terminology                                 |
| Workspace memory     | Project conventions often live in context files/core memory          | Isolated `conventions`, `decisions`, `pitfalls`                                 | EasyWork's scoped project memory is richer and worth keeping                             |
| Prompt injection     | Full frozen snapshot at session start                                | One-line manifest rebuilt before every agent run; full text via `recall_memory` | Decide freshness versus stable prefix caching explicitly                                 |
| Retrieval            | Built-in core memory needs no search                                 | sqlite-vec plus lexical recall                                                  | Keep retrieval for larger workspace/derived memory, not necessarily for tiny core memory |
| Automatic extraction | Built-in files are curated; provider extraction is optional/additive | Built-in passive extraction after idle/buffer thresholds                        | EasyWork needs explicit provenance and lifecycle semantics                               |
| Conversation history | Separate FTS5 session search                                         | Separate FTS5 `session_search`                                                  | Already aligned conceptually                                                             |
| External provider    | Additive to built-in memory                                          | `MemoryProvider` abstraction suggests replacement                               | Prefer additive deep memory over replacement of local core guarantees                    |
| Security             | Stored/recalled memory is scanned                                    | No equivalent memory-specific scan found                                        | Treat persisted memory as untrusted input before system injection                        |

## Recommended EasyWork direction

Adopt a hybrid contract rather than copying Hermes literally:

- Keep a bounded **Core Memory** with two concepts: User Profile and Agent Notes.
- Keep **Workspace Memory** as isolated, retrievable project knowledge: conventions, decisions, pitfalls.
- Keep **Conversation Archive** separate and searchable through FTS5.
- Make **Skills** executable/discoverable procedure artifacts; remove the name `global.skills` from ordinary memory.
- Model automatically extracted facts as **Derived Facts** owned by a source conversation. Deleting that conversation cascades to those facts. A deliberate promotion/confirmation converts a derived fact into durable curated memory and detaches it from the source lifecycle.
- Make optional semantic/provider memory additive to the built-in local contract.
- Add threat scanning/sanitization at the memory-to-prompt boundary.

Two choices still require product discussion:

1. Whether core/workspace memory snapshots refresh each turn (fresher) or only at a defined session boundary (better prompt caching and predictability).
2. Whether SQLite is canonical with Markdown as an editable projection, or global Markdown remains canonical while workspace memory is SQLite-only.

## Primary sources

- [Hermes Persistent Memory](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/memory.md)
- [Hermes Memory Providers](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/memory-providers.md)
- [Hermes Tips: Memory vs Skills](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/guides/tips.md#memory--skills)
- [Hermes Sessions and Session Search](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/sessions.md)
- [Hermes releases: promptware defense and FTS5 session search](https://github.com/NousResearch/hermes-agent/releases)
