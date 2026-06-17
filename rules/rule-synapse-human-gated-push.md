---
id: rule-synapse-human-gated-push
type: rule
title: Push policy by repo and content type — framework PR-gated; vault self-heals Markdown; records gated everywhere
tags:
  - type/rule
  - area/governance
  - status/active
provenance: ["human-in-the-loop PR gate", "Emmanuel 2026-06-15", "per-repo/per-content amendment, Emmanuel 2026-06-16 (decision-0006-self-healing-vault)"]
---

**Rule:** The maintenance loop's remote-write policy depends on **which repo** it is in and **what content
type** is changing. The agent detects both and applies the matching gate
([[decision-0006-self-healing-vault]], amending [[decision-0003-human-gated-mutation]]):

- **Framework repo (the shared, public template) → fully PR-gated.** The loop's only remote write is
  pushing a **fresh** branch and opening a PR to `main`. It **NEVER** force-pushes, **NEVER** pushes to
  `main` (or any shared branch) directly, and **NEVER** merges its own PR. The PR is the handoff — a
  maintainer reviews and merges. Maker ≠ checker holds.
- **Private vault → self-healing for Markdown/knowledge.** For Markdown/knowledge changes (notes, journal,
  plans, projects, people-narrative, MOCs, summaries, decisions) the steward **commits and pushes
  directly** — no PR, no human gate. Git history is the audit trail and revert path. This autonomous
  upkeep is the intended design for a single-owner instance.
- **Records/DB → human-gated everywhere, including the vault.** SQLite record changes ride `migrations/`
  files through the human gate on **every** repo, exactly as [[decision-0003-human-gated-mutation]]
  specifies; a runner applies them on merge. The self-healing autonomy applies **only** to
  Markdown/knowledge — **never** to record/DB/migration changes. Never push a migration straight to a
  shared branch, and never write `db/synapse.db` directly.

In every case: **never force-push, never rewrite shared history, never self-merge a framework PR.**

**Why:** On the shared framework, human review is the irreversible-action gate and the only second pair of
eyes — a self-merging or force-pushing automation would silently land unreviewed changes or rewrite shared
history. On the solo, local-first vault, routing every reversible Markdown fix through a self-approved PR
is ceremony without a real reviewer, so direct push is safe and intended for knowledge. But the gate that
exists because **finances are in scope** — the records DB — is not relaxed anywhere: that is precisely
where unattended change is dangerous, so record/DB mutations stay human-gated migrations on every repo.

**How to apply:**
- **Detect first:** identify the repo (framework vs vault) and the change type (Markdown/knowledge vs
  record/DB/migration). A migration or any DB write is **always** in the gated bucket, vault or not.
- **Framework:** branch **fresh off the latest** `origin/main`, stage only the files you changed (**never
  `git add -A`**, never touch tooling or the DB binary), `git push -u origin HEAD` (new branch only), open
  a PR with base `main`. Never merge it yourself. If a PR comes back CONFLICTING, do **not** force-push or
  rebase-and-force — **escalate** to `inbox/attention/` ([[rule-synapse-fail-loudly]]); a clean next-pass
  branch off the new HEAD is the normal recovery.
- **Branch ownership — parent creates, subagents reuse.** Creating the fresh branch and opening the PR are
  the **top-level (parent) session's** responsibility — it branches **once** and owns the PR. A **dispatched
  subagent / reconciler does NOT create its own branch**: it works on the branch the parent already checked
  out and commits there. A subagent that spins up a second branch forks the parent's work into a dangling
  line — so "branch fresh" applies to the parent run, never to a worker it dispatches.
- **Vault, Markdown/knowledge:** commit only the files you changed (never `git add -A`) and push directly;
  no PR. Still escalate anything ambiguous, destructive, or authoring-shaped instead of guessing
  ([[rule-synapse-fail-loudly]], [[rule-no-unprompted-actions]]).
- **Vault, records/DB:** propose the change as a `migrations/` file through the human gate — never apply it
  directly. Every DELETE / bulk-UPDATE escalates, always ([[decision-0003-human-gated-mutation]]).

Related: [[decision-0006-self-healing-vault]] · [[decision-0003-human-gated-mutation]] · [[rule-synapse-fail-loudly]] · [[rule-synapse-incremental-reconcile]] · [[rule-no-unprompted-actions]] · [[doc-governance-model]]
