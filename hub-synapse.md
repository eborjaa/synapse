---
id: hub-synapse
type: hub
title: Synapse — master hub
tags:
  - type/hub
  - area/meta
  - status/active
references_docs: ["[[conventions]]", "[[doc-vision]]", "[[doc-fork-and-extend]]", "[[doc-cli-reference]]", "[[doc-npm-release]]"]
related: ["[[hub-finances]]", "[[hub-contacts]]", "[[hub-health]]", "[[hub-places]]", "[[hub-journal]]", "[[hub-projects]]", "[[hub-social-media]]", "[[hub-career]]"]
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
- [[doc-fork-and-extend]] — engine package (`@eborja/synapse`) vs. your private vault: depend via npm;
  optionally track this repo as `upstream` for reference notes.
- [[doc-npm-release]] — how to ship a new `@eborja/synapse` version (CHANGELOG → tag → human `npm publish`
  → vault bump). Agents follow this whenever asked to publish.
- [[doc-deployment-gate]] — the intended one-parent layout and the host-level privacy gate: an external
  coding agent maintains the framework while the vault stays sealed (local-only, data never leaves your
  hardware).
- [[doc-repo-layout]] — where everything lives. · [[doc-roadmap]] — what's next.

## Domains — what's inside
One hub per domain; each gathers its own notes and records as *members* via reverse-`BINDS` (a note that
declares the hub in its `related:` field rolls up as a member of that hub). Hubs also **compose**: a hub
can nest under a parent hub and hold its own sub-hubs, each layer carrying just enough about the next to
orient ([[decision-0007-composable-sub-hubs]]). They are intentionally near-empty until data lands.

**Knowledge (Markdown-canonical):**
[[hub-journal]] (dated entries) · [[hub-projects]] (projects + plans) · [[hub-social-media]] (posts, drafts)

**Records (SQL-canonical, surfaced as generated views + summaries):**
[[hub-finances]] (accounts, transactions) · [[hub-contacts]] (people) · [[hub-health]] (metrics,
workouts) · [[hub-places]] (gazetteer + visits)

**Composable (a hub unit with sub-hubs):**
[[hub-career]] (top layer) → [[hub-courses]] (sub-hub) → course notes — the reference example of nesting
([[decision-0007-composable-sub-hubs]]).

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
- **CLI & commands:** [[doc-cli-reference]] — the canonical cheat-sheet: every shell command, `node`
  script, runtime env var, and the pluggable `--cli` sinks (opencode · claude · clip · print).
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
