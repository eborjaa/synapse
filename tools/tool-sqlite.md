---
id: tool-sqlite
type: tool
title: SQLite — the records substrate (read-only query + migration runner)
tags:
  - type/tool
  - area/meta
  - status/active
---

# tool-sqlite (`db/synapse.db`)

The **records substrate**: a single SQLite file holding everything you aggregate, filter, sort, or
relate — contacts, accounts, transactions, health, locations, addresses ([[doc-sql-schema]]). One file is
trivially backed up and has no server to run or secure ([[decision-0001-sqlite-over-postgres]]).

## Two access paths, two credentials
The file is touched through exactly two doors, by design:

- **Read-only query (chat / text-to-SQL).** The query path opens the DB immutable —
  `file:db/synapse.db?mode=ro&immutable=1` (or `PRAGMA query_only=ON`). A generated query can never mutate
  or drop a table, so the model can read freely without risk ([[doc-storage-model]]).
- **Read-write migrations.** `apply-migrations.mjs` is the **only** writer. It applies pending,
  forward-only files from `migrations/NNNN-*.sql` inside a transaction, recording each in a `_migrations`
  table (idempotent — only unapplied files run).

```sh
synapse migrate            # apply pending migrations (read-write)
synapse migrate --status   # list applied / pending, write nothing
```

## How it is used in Synapse
The migration files in git **are** the records' audit log and revert path. Agents never write the DB
directly — a record change is proposed as a migration file through the human-gated PR, and a runner
applies it on merge ([[decision-0003-human-gated-mutation]]). The DB itself is gitignored: it is derived
(replayable from migrations), sensitive, and binary.

## Related
[[doc-sql-schema]] · [[doc-storage-model]] · [[decision-0001-sqlite-over-postgres]] · [[decision-0003-human-gated-mutation]]
