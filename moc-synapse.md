---
id: moc-synapse
type: moc
title: Synapse — master map of content
tags:
  - type/moc
  - area/meta
  - status/active
references_docs: ["[[conventions]]", "[[doc-vision]]", "[[doc-fork-and-extend]]"]
related: ["[[moc-finances]]", "[[moc-contacts]]", "[[moc-health]]", "[[moc-places]]", "[[moc-journal]]", "[[moc-projects]]"]
---

# Synapse — master hub

The entry point to the vault. Synapse is a private, local-first personal knowledge system: **Markdown for
knowledge, SQL for records, one ontology, and every change a reviewable diff.** This hub links the
architecture (the *why* and *how*), the domain hubs (the *what*), and the method layer (the *who* — the
agents and the loop that keep it healthy). New here? Read [[doc-vision]] first.

## Architecture — how it's built
The design notes, in reading order:

- [[doc-vision]] — vision, goals, and non-goals.
- [[doc-storage-model]] — the two substrates (Markdown vs SQL) and the two projection directions.
- [[doc-governance-model]] — read freely, write through one human-gated gate.
- [[doc-agent-architecture]] — three agents on a local OpenCode runtime; maker ≠ checker.
- [[doc-maintainer-loop]] — the nightly detect → heal → escalate → PR → log loop.
- [[doc-capture-pipeline]] — zero-friction `inbox/` capture → atomized typed notes + record rows.
- [[doc-runtime-wiring]] — OpenCode + Ollama over Tailscale; the permission posture.
- [[doc-semantic-recall]] — the opt-in hybrid-retrieval layer: deterministic render + local-embedding
  augment ([[decision-0005-hybrid-retrieval]], [[tool-ollama-embeddings]]).
- [[doc-security-privacy]] — the privacy boundary (private repo, no public endpoint).
- [[doc-fork-and-extend]] — framework vs. your vault: the two-repo model (`origin` private, `upstream`
  the framework) and the by-directory boundary.
- [[doc-deployment-gate]] — the intended one-parent layout and the host-level privacy gate: an external
  coding agent maintains the framework while the vault stays sealed (local-only, data never leaves your
  hardware).
- [[doc-repo-layout]] — where everything lives. · [[doc-roadmap]] — what's next.

## Domains — what's inside
One hub per domain; each gathers its own notes and records as *members* via reverse-`BINDS` (a note that
declares the hub in its `related:` field rolls up as a member of that hub). They are intentionally
near-empty until data lands.

**Knowledge (Markdown-canonical):**
[[moc-journal]] (dated entries) · [[moc-projects]] (projects + plans)

**Records (SQL-canonical, surfaced as generated views + summaries):**
[[moc-finances]] (accounts, transactions) · [[moc-contacts]] (people) · [[moc-health]] (metrics,
workouts) · [[moc-places]] (gazetteer + visits)

## Method — how it runs
The HOW layer the agents obey and the engine that briefs them:

- **Agents:** three writers — [[agent-curator]] (steward) · [[agent-reconciler]] (scoped doer) ·
  [[agent-ingester]] (capture) — plus one reader, [[agent-oracle]] (ask the vault). Maker ≠ checker — the
  agent that writes an edit never approves it; the oracle never writes at all, only answers and proposes
  consent-gated handoffs.
- **Loop:** [[loop-maintain-synapse]] — the standing, run-until-dry maintenance process the curator owns.
- **Schema:** [[conventions]] — the type taxonomy, frontmatter, and typed-edge rules every note follows.
- **Engine:** [[context-engine-guide]] — how `render.mjs` walks the manifest's role-closure to compile a
  deterministic `agent × target × profile` briefing.
- **Semantic recall:** [[doc-semantic-recall]] — an opt-in second phase (`augment.mjs`) that appends
  embedding-similar notes the typed graph missed. The boundary ([[rule-semantic-suggests-links-decide]]):
  additive, labeled, non-authoritative — a good hit is promoted to a typed `related:` link, so semantic
  discovery feeds the deterministic graph. Vectors come from local Ollama ([[tool-ollama-embeddings]]).

## How it stays healthy
The [[agent-curator]] runs [[loop-maintain-synapse]] on a local OpenCode runtime (Ollama over Tailscale, no
API key): orient on the inbox → detect drift (lint + DB↔view divergence + orphans + pending captures) →
heal the unambiguous → dispatch a [[agent-reconciler]] per drifted unit and verify each diff → escalate
the rest → open one human-gated PR → log the pass. A "dry" pass (nothing to do) is the common case and
counts as success. The mechanical gate is `lint.mjs` (it detects; an agent heals); the safety gate is the
PR (the agent proposes; a human merges).

## Related
[[conventions]] · [[doc-vision]]
