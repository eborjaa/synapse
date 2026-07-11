---
id: doc-roadmap
type: doc
title: Roadmap — the phased build
tags:
  - type/doc
  - area/architecture
  - status/active
references_docs: ["[[conventions]]", "[[doc-fork-and-extend]]"]
related: ["[[hub-synapse]]"]
---

# Roadmap

Built in three phases; each phase leaves the vault lint-clean and usable.

## Phase 1 — Ontology & spec
The manifest, the schema layer ([[conventions]]), and the architecture spec as typed notes:
[[doc-vision]] · [[doc-storage-model]] · [[doc-governance-model]] · [[doc-maintainer-loop]] ·
[[doc-agent-architecture]] · [[doc-security-privacy]] · [[doc-capture-pipeline]] · [[doc-repo-layout]] ·
plus the ADRs ([[decision-0001-sqlite-over-postgres]] … [[decision-0004-opencode-local-ollama-runtime]]).

## Phase 2 — Schema, engine, gate, rules
- The SQLite schema for every record domain + the read-only / read-write credential split.
- Port `render.mjs` (verbatim, manifest-driven) + add the canary/handover trailer.
- Adapt `lint.mjs` (the type map, per-type required fields, the source/path check, the generated-view guard).
- The migration-file convention + runner, and the derived-view + `.md`-index generators.
- The governance rules ([[rule-synapse-frontmatter-schema]] … [[rule-derived-views-are-generated]] + the
  constitutional rules).

## Phase 3 — Agents, loop, runtime
- [[agent-curator]] · [[agent-reconciler]] · [[agent-ingester]].
- [[loop-maintain-synapse]] + [[skill-maintain-synapse]] + the executable playbook.
- The OpenCode harness (per-agent launch + the nightly maintainer) + the runtime wiring
  ([[decision-0004-opencode-local-ollama-runtime]]).

## Phase 4 — Semantic recall (done)
Hybrid retrieval over the deterministic render — this **answers the old "RAG over Markdown" question**,
entirely local ([[decision-0005-hybrid-retrieval]], [[doc-semantic-recall]]):
- `gen-embeddings.mjs` builds a generated `note_vectors` index from local Ollama embeddings
  ([[tool-ollama-embeddings]]); the maintainer pass keeps it fresh.
- `augment.mjs` is the opt-in Phase-2 tool: it appends a labeled "semantically related" section to the
  pure `render.mjs` briefing, additive and non-authoritative ([[rule-semantic-suggests-links-decide]]).

## Phase 5 — Open-source release (framework)
Released as a public GitHub repo others can **template or clone**, then pin the engine as
`@eborja/synapse` ([[doc-fork-and-extend]]):
- MIT license, `CONTRIBUTING.md`, and issue/PR templates; the lint gate as the contribution bar.
- Engine package vs private vault: npm dependency for tooling; optional `upstream` for reference notes.
- Ownership recorded generically in `vault_meta` (seeded by the user via `0002-owner.sql`), no personal
  data in the framework.

## Phase 6 — Engine as npm package (done)
The tooling ships as **`@eborja/synapse`** on the npm registry (`npm install @eborja/synapse@^0.1.1`) —
`bin/synapse`, `lib/*`, `agents.sh`, `schema/context.manifest.example.json`. Consumers keep vault content
+ a local `context.manifest.json`; the engine resolves the vault via `$SYNAPSE_VAULT` or an ancestor walk
(flat or nested layout). SQL helpers (`migrate` / `index` / `views`) stay in-package for the
personal-knowledge substrate. See [[doc-fork-and-extend]] · [[doc-cli-reference]] · `CHANGELOG.md`.

## Later
- **Open WebUI** as an optional read-only chat front-end over the same local Ollama — still optional and
  not-yet-configured (the core loop doesn't need it).
- **A second retriever (BM25/keyword) fused via RRF** — `augment.mjs` already has the RRF seam wired for a
  single ranker; adding keyword recall is a future enhancement.
- **`sqlite-vec`** as the drop-in vector backend when the vault outgrows brute-force cosine.
- A planning `lead` agent; more record domains as they earn their place.

## Related
[[doc-vision]] · [[hub-synapse]]
