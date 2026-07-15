---
id: hub-career
type: hub
title: Career — domain hub
tags:
  - type/hub
  - area/career
  - status/active
references_docs: ["[[conventions]]"]
related: ["[[hub-synapse]]"]
---

# Career — domain hub

The map for the **career** domain — the top layer of a **composable hub unit**. It holds a little
career-wide knowledge directly (a north-star note, reviews) and **navigates down to sub-hubs** that own
the detail. A parent hub carries *just enough* about each sub-layer to orient you; the depth lives in the
child ([[decision-0007-composable-sub-hubs]]).

## What lives here
- **Career-wide notes** — direct members (e.g. [[note-career-north-star]]): goals, reviews, decisions
  that span the whole domain, not any single course or project.
- **Sub-hubs** — composable child hub units that own a slice of the domain and roll their own detail up
  under themselves, not here.

## Sub-hubs
- [[hub-courses]] — courses in progress and their notes. At `standard` this hub shows only the *courses
  map* (the sub-hub's own body); its per-course notes stay under `hub-courses` and only surface here at
  `--profile fat`. That is the point: **each layer knows its sub-layers, but not as deeply as the child
  knows them.**

## Workspace
This hub lives at **`hub/career/`**. Child workspaces nest under it (e.g. `hub/career/courses/`) so the
directory tree matches the hub tree.

## How to work this domain
- **Author career-wide prose:** a `note-*` with `related: ["[[hub-career]]"]` — Markdown is canonical.
  Prefer colocating under `hub/career/` when the note belongs to this workspace.
- **Add a sub-hub:** create `hub/career/<slug>/hub-<slug>.md` that lists **this** hub in its `related`
  (child declares parent — like a note declaring its hub) and mention it under **Sub-hubs** above for
  humans. That one edge is enough: the parent renders the sub-hub and Tab completion drills into it via
  `curator hub-career/<Tab>` ([[decision-0007-composable-sub-hubs]], [[rule-synapse-edges-by-role]]).
- **Ask across layers:** `oracle hub-career "…"` for a wide view; `oracle hub-courses "…"` to drill in.

## Members
*Populate as notes land.* Career-wide notes and sub-hubs roll up here once they link back via `related`
([[rule-synapse-edges-by-role]]).

## Related
[[decision-0007-composable-sub-hubs]] · [[conventions]] · [[hub-courses]] · [[hub-synapse]]
