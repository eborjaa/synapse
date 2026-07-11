---
id: decomposition-recipe
type: doc
title: Decomposition recipe — one raw inbox dump into typed notes and proposed rows
tags:
  - type/doc
  - area/meta
  - status/active
references_docs: ["[[conventions]]"]
related: ["[[hub-synapse]]"]
---

# Decomposition recipe

The ingester's deterministic procedure for atomizing **one** raw `inbox/` item into typed notes and
proposed record rows. Run by [[agent-ingester]] as the second half of [[doc-capture-pipeline]]; this is
the *how*, the capture philosophy ([[capture-philosophy]]) is the *why*. This note lives under `_meta/`,
so its illustrative links are not link-checked.

## The steps

1. **Classify each idea — knowledge or record.** Read the dump and separate ideas. For each: is it prose
   you read/link/narrate (→ knowledge, Markdown) or data you aggregate/filter/relate (→ record, SQL)?
   The dividing line is from [[doc-storage-model]]. A single dump can yield both.

2. **Split one-idea-per-file.** Each distinct knowledge idea becomes its own atomic note. Don't fuse two
   ideas to save a file; don't pad one idea across two. Smallness is what keeps the graph and its
   briefings legible ([[capture-philosophy]]).

3. **Name with the type prefix.** Filename basename is kebab-case, globally unique, and prefixed by type
   (`note-*`, `journal-*`, `project-*`, `plan-*`, `person-*`, `decision-*`) — the prefix *is* the `type:`
   and the linter enforces the match ([[conventions]]). The basename is the note's `id`.

4. **Wire into the right hub via `related`.** Link each note to its domain `hub-<domain>` in the
   `related:` field. The field decides the role: a `hub` target is *navigated to* and the note rolls up
   as a member of that hub — only because the link sits in `related`, the field whose role reaches a
   `hub` ([[rule-synapse-edges-by-role]]). A link in the wrong field renders nothing.

5. **Carry `provenance:`.** Every derived note (and every proposed row) cites its inbox source, so any
   fact traces back to the raw capture it came from. Provenance is non-negotiable — it is the audit trail
   for derived knowledge.

6. **Propose record rows as a migration — never write the DB.** Records become INSERTs in a new
   `migrations/NNNN-*.sql` file, not direct writes to `db/synapse.db`. The migration rides the same
   human-gated PR and *is* the records' audit log ([[decision-0003-human-gated-mutation]],
   [[rule-synapse-human-gated-push]]).

7. **Escalate ambiguous routing.** If classification is unclear, the target hub is ambiguous, or a link
   has zero-or-many candidates, write an `inbox/attention/` note with Options and **stop** on that item —
   never guess ([[rule-synapse-fail-loudly]], [[rule-no-unprompted-actions]]).

8. **Clear and propose.** Once everything is routed, clear the inbox entry and leave the notes +
   migrations on a branch for review.

## Don't restate — link
If a fact already lives somewhere, link it; never copy it into the new note
([[rule-synapse-single-source-of-truth]]). A person's narrative links to its contact record rather than
restating fields ([[decision-0002-contact-record-plus-narrative]]).

## Related
[[agent-ingester]] · [[doc-capture-pipeline]] · [[capture-philosophy]] · [[rule-synapse-edges-by-role]] · [[decision-0003-human-gated-mutation]] · [[hub-synapse]]
