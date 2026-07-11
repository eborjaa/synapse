---
id: doc-semantic-recall
type: doc
title: Semantic recall — hybrid retrieval over the deterministic graph
tags:
  - type/doc
  - area/retrieval
  - status/active
references_docs: ["[[conventions]]"]
related: ["[[hub-synapse]]"]
---

# Semantic recall

The render engine retrieves by **following typed links** — precise, but blind to relevant notes you never
linked. Semantic recall adds the missing half: **embedding-based search** that finds conceptually-related
notes across the whole vault, then *augments* (never replaces) the deterministic briefing. This is
**hybrid retrieval** (graph + vector); see [[decision-0005-hybrid-retrieval]].

## The two phases
1. **Deterministic seed (unchanged).** `render.mjs agent [+ hub] --profile P` walks the typed-link closure
   → a byte-identical briefing. `render.mjs` stays pure and offline.
2. **Semantic augment (new, opt-in).** `augment.mjs` takes that seed **plus the user's task text**, embeds
   it, runs nearest-neighbor search over the note embeddings, fuses the hits with the closure
   (Reciprocal Rank Fusion), trims to a token budget, and appends a clearly-labeled section —
   `## Semantically related (not yet linked)`. Cross-domain notes the deterministic path missed now reach
   the briefing.

## How it's built (all local)
- **`gen-embeddings.mjs`** — embeds every note body via local **Ollama** ([[tool-ollama-embeddings]]) and
  writes a generated `note_vectors` table in `synapse.db` (`id`, `model`, `dim`, `vec` BLOB, `mtime`). It
  is a **derived projection** rebuilt from the notes — never canonical, never hand-edited
  ([[rule-derived-views-are-generated]]); a `gen-embeddings` step in the maintainer pass keeps it current.
- **`augment.mjs`** — opens `note_vectors` read-only, computes cosine similarity in JS (brute force is
  ample at personal-vault scale; `sqlite-vec` is the drop-in scale path), RRF-fuses with the render
  closure, and emits the augmented briefing. The launcher calls it when a task is supplied. **Tuning:** it
  embeds the **task** (not the whole briefing, which would swamp the signal), drops hits below a similarity
  floor (`SYNAPSE_MIN_SIM`, default 0.45 — tune per embed model), and lists the top-`--k` (default 6) hits
  as short excerpts.

## The boundary that keeps it safe
Semantic results are **additive, labeled, and non-authoritative** ([[rule-semantic-suggests-links-decide]]):
- the deterministic briefing remains the spine (reproducible);
- a similarity hit never silently drives a mutation (especially near records);
- when a hit is genuinely relevant, the agent **proposes a typed `related:` link** — turning a one-off
  fuzzy match into a permanent, deterministic edge. Semantic recall is thus a **discovery mechanism that
  feeds the graph**: the vault grows more precise the more it's used.

## A concrete use: ingester dedup
Before [[agent-ingester]] creates a note, it semantically searches for an existing note covering the same
idea — enforcing [[rule-synapse-single-source-of-truth]] beyond exact-name matching.

## Related
[[decision-0005-hybrid-retrieval]] · [[rule-semantic-suggests-links-decide]] · [[tool-ollama-embeddings]] · [[doc-storage-model]] · [[doc-runtime-wiring]] · [[hub-synapse]]
