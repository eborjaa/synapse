# Migrations — the SQL write gate

The records DB (`db/synapse.db`) is **never written by hand or by an agent directly**. Every change to
canonical record data is a **forward-only migration file** here, reviewed in a PR and applied on merge by
`synapse migrate`. These files **are** the audit log and the revert path.

## Convention
- One file per change: `NNNN-slug.sql` (zero-padded, monotonic; `0001-init-schema.sql` is the schema).
- Plain SQL. **Forward-only** — never edit or delete an applied migration; to undo, add a new compensating
  migration (e.g. `0007-revert-bad-import.sql`).
- `apply-migrations.mjs` applies any file not yet recorded in the `_migrations` table, each in its own
  transaction, in filename order. Re-running is idempotent.

## What rides this gate
- **Canonical records** — contacts, accounts, balances, transactions, categories, health, places, visits,
  addresses. Inserts/updates to these are migrations.
- **NOT** the generated projections (`plans`, `notes`, `note_links`) — those are rebuilt from Markdown by
  `gen-index.mjs` (Markdown is canonical), and the derived Markdown views are rebuilt by `gen-views.mjs`
  (DB is canonical). Regenerating a projection is not a migration.

## Escalation (rule-synapse-fail-loudly)
Every `DELETE` and every bulk `UPDATE` is **escalate-and-stop**: the agent proposes the migration in the PR
with clear Options and never assumes merge. A human reviews and merges; the runner only ever applies
**merged** migrations.

## Commands
```sh
synapse migrate --status   # list applied / pending, apply nothing
synapse migrate            # apply pending (read-write)
```
