---
id: decision-0006-self-healing-vault
type: decision
title: Self-healing direct-push for Markdown on the private vault; framework stays PR-gated; records stay gated everywhere
tags:
  - type/decision
  - area/governance
  - status/active
related: ["[[doc-governance-model]]"]
---

**Status:** Accepted — 2026-06-16
Amends [[decision-0003-human-gated-mutation]] — scopes the human-gate per repo and per content type.

## Context
[[decision-0003-human-gated-mutation]] made **every** mutation human-gated: each change rides a PR a human
merges, with SQL on `migrations/` files. That blanket gate is right for the framework — a shared, public
template where an external coding agent maintains the engine and conventions — but it is heavier than the
private vault needs for its own routine upkeep. The vault is a single-owner, local-first instance: the
nightly steward's bread-and-butter work is mechanical, reversible Markdown hygiene (fixing a typo'd
wikilink, adding a missing `#type/<type>` tag, regenerating a stale derived view). Routing every such fix
through a PR the same owner immediately self-approves is ceremony without a second reviewer — the
maker ≠ checker guarantee the framework relies on has no counterpart on a solo vault.

What must **not** change is the gate that exists because **finances are in scope**: record/DB mutations
(SQLite via `migrations/`) are exactly where silent, unattended change is dangerous, and decision-0003's
reasoning applies to them undiminished — on the vault as much as the framework.

So the policy splits along two axes the agent can detect: **which repo** it is operating in (framework vs
the private vault) and **what content type** is changing (Markdown/knowledge vs record/DB).

## Decision
The agent **detects the repo and the change type** and applies the matching policy:

- **Framework repo — unchanged, fully PR-gated.** The agent opens a fresh branch and a PR to `main`, and
  **never** pushes to `main` directly, **never** force-pushes, and **never** self-merges. A maintainer
  reviews in the PR UI and merges. Maker ≠ checker holds; decision-0003 governs in full.
- **Private vault — self-healing for Markdown/knowledge.** For Markdown/knowledge changes (notes, journal,
  plans, projects, people-narrative, MOCs, summaries, decisions) the steward **commits and pushes directly**
  — no PR, no human gate. This autonomous upkeep is the intended design for a single-owner instance; git
  history remains the audit trail and revert path.
- **Records/DB — gated everywhere, including the vault.** SQLite record changes ride `migrations/` files
  and **remain human-gated exactly as [[decision-0003-human-gated-mutation]] specifies**, on every repo.
  The self-healing autonomy applies **only** to Markdown/knowledge — **never** to record/DB/migration
  changes. The DB gate is **not** loosened.

The canonical, applies-to-everyone statement of this per-repo/per-content model lives in
[[rule-synapse-human-gated-push]]; this ADR records *why*.

## Consequences
- (+) The vault heals its own Markdown hygiene unattended — no self-approval ceremony for a solo owner.
- (+) The finances-bearing gate is preserved intact: every record/DB mutation stays a reviewable,
  human-merged migration, everywhere ([[decision-0003-human-gated-mutation]]).
- (+) The framework's maker ≠ checker review survives untouched for the shared, public template.
- (↔) The agent now carries a detection responsibility (repo + change type); the wrong call would either
  over-gate (harmless ceremony) or — the risk to guard — push a record change without review, which the
  record/DB-stays-gated rule and the migration-only DB writer ([[rule-derived-views-are-generated]]) forbid.
- (−) Direct vault pushes lose the pre-merge review window for Markdown; mitigated by git history (every
  change is still a revertible diff) and by fail-loudly escalation of anything ambiguous or destructive.

## Related
[[doc-governance-model]] · [[decision-0003-human-gated-mutation]] · [[rule-synapse-human-gated-push]] · [[rule-synapse-fail-loudly]] · [[rule-no-unprompted-actions]]
