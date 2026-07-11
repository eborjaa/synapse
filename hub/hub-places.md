---
id: hub-places
type: hub
title: Places — domain hub
tags:
  - type/hub
  - area/places
  - status/active
references_docs: ["[[doc-sql-schema]]", "[[doc-storage-model]]"]
related: ["[[hub-synapse]]"]
---

# Places — domain hub

The map for the **places** domain: a gazetteer of named places and a visit log. Geolocation records are
SQL-canonical and high-volume, so they live in `db/synapse.db` (`places` + `visits`) and surface as
aggregate `summary` notes rather than one note per visit ([[doc-sql-schema]]).

## What lives here
- **Places** — a gazetteer of named locations.
- **Visits** — a manual/imported log, SQL-only, queried with read-only text-to-SQL and rolled up into
  geo summaries.

## How to work this domain
- **Add places/visits:** a `migrations/` file writes to `places` / `visits`; apply with
  `apply-migrations.mjs` on merge.
- **Query:** read-only text-to-SQL; roll visits into geo `summary` notes via `gen-views.mjs`.
- **Maintenance pass:** `reconciler hub-places` for one stale summary, or `curator hub-places` to sweep.

## Members
*Populate as records and notes land.* Place-related summaries roll up here once they link back via
`related` ([[rule-synapse-edges-by-role]]).

## Related
[[doc-sql-schema]] · [[doc-storage-model]] · [[hub-synapse]]
