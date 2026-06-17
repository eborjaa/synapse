---
id: doc-agent-architecture
type: doc
title: Agent architecture — three writers + one reader on a local OpenCode runtime
tags:
  - type/doc
  - area/architecture
  - status/active
references_docs: ["[[conventions]]"]
related: ["[[moc-synapse]]", "[[tool-opencode]]"]
---

# Agent architecture

Four agents, one runtime. **Three writers** on one rule — *the agent that writes an edit never approves it* —
plus **one reader** that never writes at all.

## The three writers
- **[[agent-curator]]** — the *steward*. Owns the maintenance loop ([[loop-maintain-synapse]]): orient on the
  inbox, detect drift (lint + DB↔view divergence + orphans + pending captures), heal the unambiguous,
  dispatch a reconciler per drifted unit, **verify each diff**, escalate the rest, open one human-gated PR,
  log the pass. Detects and plans; rarely edits content itself.
- **[[agent-reconciler]]** — the *scoped doer*. Given one drifted unit and its scoped briefing, makes the
  minimal targeted edit (regenerate a stale view, fix a unit's notes) and reports back. Never detects,
  never opens a PR, never authors from scratch.
- **[[agent-ingester]]** — the *capture ingester*. Atomizes a freeform `inbox/` dump into one-idea-per-file
  notes (or proposes record rows as a migration), carrying `provenance:`, then clears the inbox entry.

## The reader
- **[[agent-oracle]]** — the *read front door*. You point it at a `moc-<domain>` and ask a question; it
  answers grounded in that domain's typed closure plus query-driven semantic recall ([[doc-semantic-recall]]),
  citing every claim and abstaining when the context is silent ([[rule-answer-grounded]]). It never edits,
  migrates, or opens a PR — its one action is to **propose a consent-gated handoff** to a writer
  (ingester/reconciler/curator) when it spots a gap, triggered only on explicit human approval.

## Maker ≠ checker
The reconciler (maker) writes; the curator (checker) reviews the diff — in scope? single-sourced?
schema-clean? no stray edits? — repairs the unambiguous, escalates the rest, and is the only one that
opens the PR. A human merges ([[doc-governance-model]]). From-scratch authoring is escalated, never
auto-run.

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
A planning `lead` (decompose a multi-step goal, delegate to the writers) can be added later; the core loop
needs only curator + reconciler + ingester, and the oracle answers on demand alongside them.

## Related
[[doc-governance-model]] · [[doc-maintainer-loop]] · [[doc-runtime-wiring]] · [[decision-0004-opencode-local-ollama-runtime]] · [[agent-curator]] · [[agent-reconciler]] · [[agent-ingester]] · [[agent-oracle]] · [[moc-synapse]]
