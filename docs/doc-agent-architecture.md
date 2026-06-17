---
id: doc-agent-architecture
type: doc
title: Agent architecture — three roles on a local OpenCode runtime
tags:
  - type/doc
  - area/architecture
  - status/active
references_docs: ["[[conventions]]"]
related: ["[[moc-synapse]]", "[[tool-opencode]]"]
---

# Agent architecture

Three agents, one runtime, one rule: **the agent that writes an edit never approves it.**

## The three roles
- **[[agent-curator]]** — the *steward*. Owns the maintenance loop ([[loop-maintain-synapse]]): orient on the
  inbox, detect drift (lint + DB↔view divergence + orphans + pending captures), heal the unambiguous,
  dispatch a reconciler per drifted unit, **verify each diff**, escalate the rest, open one human-gated PR,
  log the pass. Detects and plans; rarely edits content itself.
- **[[agent-reconciler]]** — the *scoped doer*. Given one drifted unit and its scoped briefing, makes the
  minimal targeted edit (regenerate a stale view, fix a unit's notes) and reports back. Never detects,
  never opens a PR, never authors from scratch.
- **[[agent-ingester]]** — the *capture ingester*. Atomizes a freeform `inbox/` dump into one-idea-per-file
  notes (or proposes record rows as a migration), carrying `provenance:`, then clears the inbox entry.

## Maker ≠ checker
The reconciler (maker) writes; the curator (checker) reviews the diff — in scope? single-sourced?
schema-clean? no stray edits? — repairs the unambiguous, escalates the rest, and is the only one that
opens the PR. A human merges ([[doc-governance-model]]). From-scratch authoring is escalated, never
auto-run.

## Which agent for which task
Route any prompt by three axes: **read vs write**, **new input vs existing drift**, **one unit vs
sweep + PR**.

- a question / retrieve / explain → a **read-only render** of the relevant `moc-<domain>` (the
  briefing engine, [[context-engine-guide]]); none of the three writers is invoked for a pure read.
- new raw input to file / atomize → **[[agent-ingester]]** (and if it fits no existing domain, the
  ingester proposes a new `moc-<domain>`).
- one existing note / view drifted from its source → **[[agent-reconciler]]** (scoped; no PR; never
  authors from scratch).
- whole-vault sweep / verify others' diffs / open the PR → **[[agent-curator]]** (steward).

## The runtime — local OpenCode + Ollama over Tailscale
Agents run on **OpenCode** (`opencode-ai`), pointed at **Ollama** over **Tailscale** — local models, no API
key, no cloud ([[decision-0004-opencode-local-ollama-runtime]]). A briefing is compiled deterministically
by the render engine (`agent × target × profile`) and passed to OpenCode:

```sh
# render the briefing, then run the agent headlessly on the local model
opencode run -m ollama/qwen3.6-256k --dir . \
  "$(node _meta/tools/render.mjs agent-curator loop-maintain-synapse --profile standard)"
```

- **Briefing in, not files ad-hoc.** The render engine hands each agent exactly its rules, skills, tools,
  and the target's neighborhood — byte-identical every run ([[context-engine-guide]]).
- **Constrained, not skip-permissions.** The nightly curator runs under an OpenCode **permission config**
  (read freely; edits and shell gated) plus the human-gated PR — never blanket
  `--dangerously-skip-permissions`, which is unsafe for a finances-bearing vault.
- **Plan then Build.** Detection runs read-only (Plan); only the autofix step edits (Build), and only the
  `.md` it touched.

## Optional lead
A planning `lead` (decompose a multi-step goal, delegate to the three) can be added later; the core loop
needs only curator + reconciler + ingester.

## Related
[[doc-governance-model]] · [[doc-maintainer-loop]] · [[doc-runtime-wiring]] · [[decision-0004-opencode-local-ollama-runtime]] · [[agent-curator]] · [[agent-reconciler]] · [[agent-ingester]] · [[moc-synapse]]
