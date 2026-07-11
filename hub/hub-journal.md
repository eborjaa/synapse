---
id: hub-journal
type: hub
title: Journal — domain hub
tags:
  - type/hub
  - area/journal
  - status/active
references_docs: ["[[doc-storage-model]]", "[[doc-capture-pipeline]]"]
related: ["[[hub-synapse]]"]
---

# Journal — domain hub

The map for the **journal** domain: dated, narrative entries. Journal is pure knowledge — Markdown is
canonical ([[doc-storage-model]]). Entries usually arrive through capture: a freeform dump lands in
`inbox/`, and the ingester atomizes it into one-idea-per-file `journal-*` notes wired here
([[doc-capture-pipeline]], [[decomposition-recipe]]).

## What lives here
- **Journal entries** — `journal-*` notes, one idea per file, each linking back to this hub via
  `related`.

## How to work this domain
- **Capture:** dump a freeform thought into `inbox/`, then `ingester <inbox-item>` atomizes it into
  one-idea-per-file `journal-*` notes, each wired here via `related` ([[doc-capture-pipeline]]).
- **Author directly:** create a `journal-*.md` with `related: ["[[hub-journal]]"]` — Markdown is
  canonical, so no migration is involved.
- **Maintenance pass:** `reconciler hub-journal` to tidy one entry, or `curator hub-journal` to sweep.

## Members
*Populate as records and notes land.* Journal entries roll up here once they link back via `related`
([[rule-synapse-edges-by-role]]).

## Related
[[doc-storage-model]] · [[doc-capture-pipeline]] · [[decomposition-recipe]] · [[hub-synapse]]
