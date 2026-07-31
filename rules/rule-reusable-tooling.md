---
id: rule-reusable-tooling
type: rule
title: Build reusable tools, not throwaway scripts — and evolve them
tags:
  - type/rule
  - area/governance
  - status/active
related: ["[[rule-synapse-human-gated-push]]", "[[rule-derived-views-are-generated]]", "[[rule-synapse-fail-loudly]]", "[[agent-ingester]]"]
---

**Rule:** When a task needs data transformed, ingested, or projected, **invest in a durable, reusable tool**
under `_meta/tools/` rather than scripting ad-hoc on the go. A committed tool is reviewable, deterministic,
and re-runnable; a one-off script is none of those and is paid for again every time. The discipline has
three parts:

1. **Tool, not script.** Consolidate the proven logic into a named tool with a usage header, flags
   (`--dry-run`), and a single clear job. A `_tmp-*` script is a smell — once its logic works, promote it
   into a tool and delete the scratch copy.
2. **Writes go through tools, including DB writes.** The gate is not "never touch the records DB" — it is
   "every write goes through a developed, reviewable tool, never improvised SQL." A tool may write the DB
   **via the canonical path**: it generates a `migrations/NNNN-*.sql` file (the durable audit log + revert
   path) and applies it through `apply-migrations.mjs` (the one writer). Markdown projections are
   regenerated as generated views (`generated: true` + `source` — [[rule-derived-views-are-generated]]).
   The tool should produce **all** the artifacts the task implies end-to-end (rows **and** notes **and**
   the derived summaries/index), so nothing is reworked by hand afterward.
3. **Judge robustness and drift each run; evolve the tool.** After running a tool, check its output against
   the source and the intent: is it complete, are the numbers right, has the schema or the input shape
   drifted past what the tool handles? If the tool is insufficient or drifting, **improve it or build a new
   one** — don't paper over the gap with a manual edit. Tools are living artifacts that get sharper each
   iteration as the owner's asks evolve; a manual fix that bypasses the tool guarantees the next run
   reproduces the flaw.

**Why:** Re-deriving the same extraction/ingestion logic from scratch each session wastes tokens, time, and
attention, and every hand-rolled variant is a fresh chance to introduce the drift the vault exists to
prevent — fabricated values, duplicated facts, broken projections. A small, reviewed, improving toolset is
how a single agent keeps a growing vault correct and cheap to maintain over time. It is the build-side
mirror of "every change a reviewable diff": every transform a reviewable tool.

**How to apply:**
- Reach for an existing `_meta/tools/` tool first; extend it before writing anything new. Reserve scratch
  scripts for genuine exploration, and never commit them — promote or delete.
- A tool that mutates records emits a migration and applies it via `apply-migrations.mjs`; it never writes
  `db/synapse.db` with improvised SQL ([[rule-synapse-human-gated-push]], [[doc-storage-model]]).
- Make tools **idempotent and re-runnable**: dedup record inserts against the DB, regenerate Markdown views
  freely, support `--dry-run`.
- When output looks wrong, incomplete, or the input format changed, fix the **tool** and re-run; escalate
  only what is genuinely ambiguous ([[rule-synapse-fail-loudly]]). Record the new/changed tool in the
  relevant runbook so the next session reuses it.

**Reference shape:** a domain ingester that handles every input variant it will meet, emits a
`migrations/NNNN-*.sql` plus the per-row notes, then chains the summary/index regeneration — one
command, idempotent, `--dry-run`-able — with its runbook in a `doc-*` note beside it.

Related: [[rule-synapse-human-gated-push]] · [[rule-derived-views-are-generated]] · [[rule-synapse-fail-loudly]] · [[agent-ingester]]
