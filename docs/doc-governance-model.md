---
id: doc-governance-model
type: doc
title: Governance & mutation model — read freely, write through one gate
tags:
  - type/doc
  - area/governance
  - status/active
references_docs: ["[[conventions]]"]
related: ["[[hub-synapse]]"]
---

# Governance & mutation model

Reads are free; every write becomes a reviewable diff a human merges. Nothing applies unattended.

## Read freely
The model may query both stores — RAG over Markdown + **read-only** text-to-SQL. The query credential is
read-only ([[doc-security-privacy]]): a generated query can never mutate or drop a table.

## Write through the gate that fits — by repo and content type
Every change is a reviewable, revertible diff in git; **what kind of review** depends on the repo and the
content type. The canonical, applies-to-everyone policy is [[rule-synapse-human-gated-push]]
([[decision-0006-self-healing-vault]], amending [[decision-0003-human-gated-mutation]]):
- **Framework repo** — fully PR-gated: every change rides a PR a human reviews and merges; the agent never
  pushes to `main` directly and never self-merges ([[rule-no-unprompted-actions]]).
- **Private vault, Markdown/knowledge** — self-healing: the steward commits and pushes directly, no PR.
  Git history is the audit trail and revert path.
- **Records/SQL — gated everywhere, including the vault** — record changes ride **migration files** through
  the human gate on every repo; a runner applies them on merge ([[doc-storage-model]]). The migration
  files in git **are** the audit log and the revert path. The self-healing autonomy never extends to the
  records DB, because finances are in scope.

## Autofix vs escalate — what keeps the gate real
- **Autofix** — trivial, reversible, unambiguous fixes (malformed frontmatter, a single-candidate typo'd
  link, a stale generated view) are prepared *into* the PR, still visible before merge.
- **Escalate-and-stop** — ambiguous, destructive, authoring, or deletion calls go to `inbox/attention/`
  with clear Options, and the agent **stops** on that item ([[rule-synapse-fail-loudly]]). Every **DELETE**
  and **bulk-UPDATE** lives permanently in the escalate bucket.

## Maker ≠ checker
The agent that writes an edit never approves it. The scoped doer ([[agent-reconciler]]) makes the minimal
edit; the steward ([[agent-curator]]) reviews the diff (in scope? single-sourced? schema-clean? no stray
edits?), repairs the unambiguous, and escalates the rest. On the **framework** this culminates in a PR a
human merges; on the **vault**, the steward pushes the verified Markdown directly while record changes
still await the human migration gate ([[rule-synapse-human-gated-push]]).

## Fail loudly
Unresolved lint errors are surfaced in the run summary and the PR body — never swallowed to fake a clean
run. When in doubt, escalate; never guess ([[rule-synapse-fail-loudly]]).

## Related
[[doc-storage-model]] · [[doc-security-privacy]] · [[doc-maintainer-loop]] · [[decision-0003-human-gated-mutation]] · [[decision-0006-self-healing-vault]] · [[rule-synapse-human-gated-push]] · [[rule-synapse-fail-loudly]] · [[rule-no-unprompted-actions]] · [[agent-curator]] · [[agent-reconciler]] · [[hub-synapse]]
