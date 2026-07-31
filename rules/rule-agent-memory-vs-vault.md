---
id: rule-agent-memory-vs-vault
type: rule
title: Vault holds knowledge, agent memory holds routing — a pointer, never a copy
tags:
  - type/rule
  - area/governance
  - status/active
related: ["[[rule-synapse-single-source-of-truth]]", "[[conventions]]", "[[rule-answer-grounded]]"]
---

**Rule:** Durable knowledge lives in the vault. A CLI agent's private memory store (Claude Code's
`~/.claude/projects/<slug>/memory/`, Cursor rules, any equivalent) holds **routing hints and
CLI-specific behavior only**. Memory may point at a note; it must **never copy one**.

This is [[rule-synapse-single-source-of-truth]] applied across the vault/agent-memory boundary.

## Why the boundary is not cosmetic

Agent memory is auto-loaded into context before any question is asked, so it reads as
authoritative. But it is **untracked, unlinted, unlinked, and invisible** to every other agent —
they see only the vault, through the MCP server or a rendered briefing. A fact kept in both stores
therefore drifts *silently and asymmetrically*: the vault copy stays linted and reviewed while the
memory copy quietly goes stale, yet the stale one is what loads first.

Observed in practice: a memory file duplicated a metrics table that a vault doc already declared the
single source of truth — and the memory copy had fallen behind. Nothing flagged it, because nothing
lints agent memory.

## The three tests

1. **Would another agent, or the owner in Obsidian, want this?** → vault note.
2. **Does only this one CLI need it to behave correctly here?** (owner corrections, harness quirks,
   "run X before Y") → memory.
3. **Is it a cheap always-on hint that saves a retrieval call?** → memory, as a **pointer** —
   the note's id or path, never its content.

## Consequences

- Memory stays small. Growth past a handful of entries means knowledge is leaking out of the vault;
  relocate it and leave a pointer.
- Memory is **disposable by design** — anything in it must be reconstructible from the vault.
- Memory entries are point-in-time; prefer pointers ("finance questions → `hub-finances`") over
  specifics ("the flag is `--foo`"), because pointers age far better than facts.
- **Standing agents that run with the vault as their working directory share the operator's memory
  store** and can write into it unattended. Relocate what they leave and delete the original.

## Related
[[rule-synapse-single-source-of-truth]] · [[conventions]] · [[rule-answer-grounded]]
