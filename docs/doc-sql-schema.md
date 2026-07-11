---
id: doc-sql-schema
type: doc
title: SQL schema — the records substrate
tags:
  - type/doc
  - area/architecture
  - status/active
references_docs: ["[[doc-storage-model]]"]
related: ["[[hub-synapse]]"]
---

# SQL schema

The records substrate is SQLite at `db/synapse.db` ([[decision-0001-sqlite-over-postgres]]). The schema is
defined by the **migrations** (`migrations/NNNN-*.sql`), which are the DB's source of truth and audit log;
`0001-init-schema.sql` creates everything below.

## Tables
- **Vault meta:** `vault_meta` — a small key/value table for vault identity/ownership (`owner`,
  `owner_handle`, `vault_created`). Created empty by `0001-init-schema.sql`; **seeded by you** via a copy of
  `migrations/0002-owner.sql.example` → `0002-owner.sql` (no identity data ships in the framework).
- **Contacts:** `contacts` + child tables `contact_emails`, `contact_phones`, `addresses`. `slug` ties a
  row to `contacts/<slug>.md`; narrative lives in an optional `person-<slug>` note, linked never duplicated
  ([[decision-0002-contact-record-plus-narrative]]).
- **Finances:** `accounts`, `account_balances` (time-series), `categories` (hierarchical), `transactions`
  — money is **integer cents**, dates **ISO-8601 TEXT**.
- **Health:** `health_metrics` (tall/flexible — `metric` is a string, so a new metric needs no migration),
  `workouts`.
- **Geolocation:** `places` (gazetteer of named places) + `visits` (manual/imported log).
- **Generated (Markdown → SQL):** `plans` (from `plan-*` frontmatter), `notes` + `note_links` (the `.md`
  index) — rebuilt by `gen-index.mjs`; and `note_vectors` (`id`, `model`, `dim`, `vec` BLOB, `mtime`) — one
  embedding per note, rebuilt by `gen-embeddings.mjs` for semantic recall ([[doc-semantic-recall]]). All are
  derived projections, never hand-written ([[rule-derived-views-are-generated]]).

## Two credentials
- **Query / chat = read-only:** open `file:db/synapse.db?mode=ro&immutable=1` (or `PRAGMA query_only=ON`). A
  generated query can never mutate or drop a table ([[doc-security-privacy]]).
- **Ingest / migration = read-write:** only `apply-migrations.mjs`, applying merged migration files
  ([[decision-0003-human-gated-mutation]]).

## Two projection directions
- **SQL → Markdown:** `gen-views.mjs` regenerates `contacts/<slug>.md`, `accounts/<slug>.md`, and
  `summary-*` notes from canonical rows.
- **Markdown → SQL:** `gen-index.mjs` regenerates `plans`, `notes`, `note_links` from the vault.

Either way, the projection is generated and never hand-edited ([[rule-derived-views-are-generated]]).

## Related
[[doc-storage-model]] · [[decision-0001-sqlite-over-postgres]] · [[decision-0003-human-gated-mutation]] · [[doc-security-privacy]] · [[hub-synapse]]
