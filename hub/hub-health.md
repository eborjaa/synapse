---
id: hub-health
type: hub
title: Health — domain hub
tags:
  - type/hub
  - area/health
  - status/active
references_docs: ["[[doc-sql-schema]]", "[[doc-storage-model]]"]
related: ["[[hub-synapse]]"]
---

# Health — domain hub

The map for the **health** domain: metrics and workouts. Health records are SQL-canonical and largely
time-series, so they live in `db/synapse.db` and surface as aggregate `summary` notes, not one note per
reading ([[doc-sql-schema]]). The `health_metrics` table is intentionally tall and flexible — a new
metric is just a new string value, no migration required.

## What lives here
- **Metrics & workouts** — SQL-only, queried with read-only text-to-SQL.
- **Summaries** — periodic `summary-health-<period>` roll-ups, generated from canonical rows.

## How to work this domain
- **Add readings:** a `migrations/` file appends to `health_metrics` (a new metric is just a new string
  value — no migration to the schema); apply with `apply-migrations.mjs` on merge.
- **Query:** read-only text-to-SQL over the DB; roll trends into `summary-health-<period>` notes via
  `gen-views.mjs`.
- **Maintenance pass:** `reconciler hub-health` for one stale summary, or `curator hub-health` to sweep.

## Members
*Populate as records and notes land.* Health summaries roll up here once they link back via `related`
([[rule-synapse-edges-by-role]]).

## Related
[[doc-sql-schema]] · [[doc-storage-model]] · [[hub-synapse]]
