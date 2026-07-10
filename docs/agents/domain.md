# Domain Docs

This repository uses a single-context domain documentation layout.

## Before exploring, read these

- `CONTEXT.md` at the repository root
- Relevant architectural decisions under `docs/adr/`

If either location does not exist, proceed silently. Do not create placeholder
domain documents. The `/domain-modeling` skill creates them lazily when terms
or architectural decisions are resolved.

## Layout

```
/
├── CONTEXT.md
├── docs/
│   └── adr/
├── apps/
└── packages/
```

## Use the glossary vocabulary

When output names a domain concept—in an issue title, proposal, hypothesis, or
test name—use the term defined in `CONTEXT.md`. Do not drift to synonyms that
the glossary explicitly avoids.

If a required concept is absent, reconsider whether the term belongs to the
project or record the gap for `/domain-modeling`.

## Flag ADR conflicts

If proposed work contradicts an existing ADR, surface the conflict explicitly
instead of silently overriding the decision.
