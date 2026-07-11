---
id: hub-projects
type: hub
title: Projects — domain hub
tags:
  - type/hub
  - area/projects
  - status/active
references_docs: ["[[doc-storage-model]]", "[[conventions]]"]
related: ["[[hub-synapse]]"]
---

# Projects — domain hub

The map for the **projects** domain: active projects and their plans. Projects are knowledge — Markdown is
canonical ([[doc-storage-model]]). A `project` note holds the narrative; `plan` notes carry the structured
intent (their frontmatter is also indexed into the SQL `plans` table for querying, generated never
hand-written — [[rule-derived-views-are-generated]]).

## What lives here
- **Project notes** — `project-*`, the narrative hub for a body of work.
- **Plan notes** — `plan-*`, structured plans that roll up under their project and this hub.

## How to work this domain
- **Author directly:** create a `project-*.md` for the narrative and `plan-*.md` for structured intent,
  each with `related: ["[[hub-projects]]"]` — Markdown is canonical, no migration involved.
- **Index plans:** `synapse index` rebuilds the SQL `plans` table from plan frontmatter
  (generated, never hand-written — [[rule-derived-views-are-generated]]) for text-to-SQL queries.
- **Maintenance pass:** `reconciler hub-projects` to reconcile one note, or `curator hub-projects` to sweep.

## Members
*Populate as records and notes land.* Project and plan notes roll up here once they link back via
`related` ([[rule-synapse-edges-by-role]]).

## Related
[[doc-storage-model]] · [[conventions]] · [[hub-synapse]]
