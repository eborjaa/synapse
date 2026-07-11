---
id: hub-social-media
type: hub
title: Social media — domain hub
tags:
  - type/hub
  - area/social-media
  - status/active
references_docs: ["[[doc-storage-model]]", "[[doc-capture-pipeline]]"]
related: ["[[hub-synapse]]"]
---

# Social media — domain hub

The map for the **social-media** domain: post drafts, published-post notes, and engagement roll-ups.
Social media is knowledge — Markdown is canonical ([[doc-storage-model]]). Drafts and notes usually arrive
through capture: a freeform idea lands in `inbox/`, and the ingester atomizes it into one-idea-per-file
notes wired here ([[doc-capture-pipeline]], [[decomposition-recipe]]).

## What lives here
- **Post drafts** — `note-*` (or `journal-*`) notes for in-progress LinkedIn/X posts, one idea per file.
- **Published-post notes** — a note per shipped post, recording what went out and where.
- **Engagement summaries** — periodic roll-ups over a post's reach/replies, kept as `summary` notes.

## How to work this domain
- **Capture:** dump a freeform post idea into `inbox/`, then `ingester <inbox-item>` atomizes it into
  one-idea-per-file notes, each wired here via `related` ([[doc-capture-pipeline]]).
- **Author directly:** create a note with `related: ["[[hub-social-media]]"]` — Markdown is canonical, so
  no migration is involved.
- **Maintenance pass:** `reconciler hub-social-media` to tidy one note, or `curator hub-social-media` to
  sweep.

## Members
*Populate as records and notes land.* Post drafts, published-post notes, and engagement summaries roll up
here once they link back via `related` ([[rule-synapse-edges-by-role]]).

## Related
[[doc-storage-model]] · [[doc-capture-pipeline]] · [[decomposition-recipe]] · [[hub-synapse]]
