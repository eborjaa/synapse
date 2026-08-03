---
id: note-synapse-mcp-backlog
type: note
title: Synapse MCP idea backlog — tools to build when a domain owns a suite
tags:
  - type/note
  - area/synapse
  - status/active
related: ["[[hub-synapse]]", "[[note-synapse-harness-playbook]]"]
---

# Synapse MCP idea backlog — tools to build when a domain owns a suite

Tool ideas for when a domain in the vault grows big enough to **own a suite** — the MCP surface you'd add
on top of the read/handover/authoring core. Each idea names the **playbook pattern** it serves
([[note-synapse-harness-playbook]]) and stays a *shape*, not an implementation. Paper only; nothing here is
built.

Guardrail carried from the playbook: any tool with a side effect (P6) **proposes by default and writes on an
explicit flag** — the same human gate the authoring tools already use.

## Idea backlog

| Tool (shape) | Serves | Why |
|---|---|---|
| `*_list_slices` / `*_brief_slice` | P4 | Enumerate/brief a domain slice by name, mirroring scope→hub without hardcoded paths. |
| Run-artifact ingest (by reference) | P8 | Attach run outputs (test results, logs) to a note as a **pointer + provenance**, never a copy. |
| `*_gap_measure` (read) | P7, P8 | Surface known-gap notes for a topic/feature so a coverage question has one answer. |
| Doctor-over-MCP | P7 | Expose the runtime-aware health probe as a tool so an agent can self-check; must report "down" vs "absent" distinctly. |
| Side-effect tools behind explicit-ask | P6 | Tickets / CI / commits — off by default, named in the dispatch, `write:true`-gated. |
| Heartbeat / cadence trigger | P3 | Fire a standing agent's periodic job (lint, hygiene) on its own clock. |
| Separate work MCP from the personal MCP | P1 | Keep a domain/work suite's MCP as its **own package**; don't overload the personal Synapse MCP. |

## Shipped from this exercise (proof the loop works)

- **`body` param on `synapse_create_*`** — the authoring tools now take a full Markdown body, so a note is
  created *with its content* in one proposal instead of a scaffold-then-edit two-step. Surfaced by writing
  [[note-synapse-harness-playbook]]; serves P6 (still proposes first, writes on `write:true`). This note and
  the playbook were both created through it.

## Next experiments (pick later)

- [ ] Turn P7's "down vs absent" lesson into a concrete doctor check (dependency probe before existence probe).
- [ ] Prototype `*_brief_slice` against a non-QA hub (e.g. `hub-health`) to prove the pattern is domain-agnostic.
- [ ] Only on explicit ask: wire a real side-effect tool (ticket create) to test the `write:true` gate end-to-end.

## Related
[[hub-synapse]] · [[note-synapse-harness-playbook]]
