---
id: doc-storage-model
type: doc
title: Storage model — two substrates, two projection directions
tags:
  - type/doc
  - area/architecture
  - status/active
references_docs: ["[[conventions]]"]
related: ["[[hub-synapse]]"]
---

# Storage model

Synapse keeps knowledge and records in two stores, each canonical in its own domain, joined by one
ontology and kept consistent by generated projections. This note is the map of that split.

## The two substrates
- **Markdown-in-Git** — canonical for *knowledge*: `note`, `journal`, `plan`, `project`, `person`
  narrative, `decision`. Authored in Obsidian, versioned in git, read by the render engine.
- **Local SQL (SQLite)** — canonical for *records*: contacts, accounts, transactions, health,
  geolocation, addresses. One file (`db/synapse.db`), reachable only on the local machine / Tailnet.

**The dividing line:** if you aggregate, filter, sort, or relate it → SQL. If you read, link, or
narrate it → Markdown. Neither store overrules the other in its own domain
([[rule-synapse-single-source-of-truth]]).

## Why SQLite (not Postgres)
Single user, one machine, access funneled through one chat UI: a single file is trivially backed up and
has no server to run or secure. The query path opens the DB **read-only** (an immutable / `query_only`
connection) so a generated query can never mutate or drop a table; only the migration runner opens it
read-write. Postgres would add an engine-level `SELECT`-only role and direct multi-device access — neither
is needed here, and the migration-file gate works the same either way, so the door to Postgres stays open.
(ADR: [[decision-0001-sqlite-over-postgres]].)

## Two projection directions
The substrates project into each other. Whichever side is canonical, the other is **generated and never
hand-edited** ([[rule-derived-views-are-generated]]):

| Direction | Canonical | Generated | Examples |
|---|---|---|---|
| **SQL → Markdown** (derived views) | DB row | read-only `.md` view | `contacts/<slug>.md`, `accounts/<slug>.md`, `summary-finances-<period>.md` |
| **Markdown → SQL** (indexes) | the note | SQL table | `notes` + `note_links` (the `.md` index), `plans` (from plan frontmatter) |

- **Derived views** keep records linkable in Obsidian and visible in git without making the DB
  hand-editable. Low-cardinality records (`contact`, `account`) get one view per row; high-volume /
  time-series records (transactions, health, geolocation, addresses) get **aggregate** `summary` notes,
  not one note each.
- **The `.md` index** is the inverse: it persists the link graph the linter already computes so the model
  can answer structural questions with text-to-SQL ("which notes are orphans", "what links to
  `hub-finances`", "biggest notes"). Markdown stays canonical; the table is rebuilt from the notes.

## What lives where (git vs local)
- **In git (private repo):** all Markdown (knowledge + derived views), the manifest, the tooling, and the
  **migration files** — which double as the records' audit log and revert path.
- **Local only (gitignored):** `db/synapse.db` — it is derived (replayable from migrations), sensitive, and
  binary. Back it up by file copy, not git.
- **Privacy boundary:** the repo is private and reachable only over Tailscale; there is no public
  endpoint. The secret scanner catches keys/tokens/passwords but **not** amounts or account numbers, so
  record privacy rests on the private repo + read-only query credential + the derived-view design — not
  on the linter. (See [[doc-security-privacy]].)

## Mutation flows one way, through a gate
Reads may touch both stores (text-to-SQL + RAG over Markdown). Writes never happen unattended: Markdown
changes ride git's PR diff; SQL changes ride **migration files** through the *same* PR gate
([[doc-governance-model]], [[rule-synapse-human-gated-push]]). The agent proposes, a human merges, a runner
applies the migration on merge. The slight delay between propose and apply is the feature, not a cost.

## Related
[[conventions]] · [[doc-governance-model]] · [[doc-security-privacy]] · [[rule-synapse-single-source-of-truth]] · [[rule-derived-views-are-generated]] · [[hub-synapse]]
