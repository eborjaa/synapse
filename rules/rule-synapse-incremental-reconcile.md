---
id: rule-synapse-incremental-reconcile
type: rule
title: The loop reconciles, it does not regenerate — scoped, minimal, escalate from-scratch authoring
tags:
  - type/rule
  - area/governance
  - status/active
provenance: ["loop-engineering: reconcile, don't regenerate", "Emmanuel 2026-06-15"]
---

**Rule:** The maintenance loop makes the **minimal targeted edit** to bring a drifted unit back in line.
It **never re-authors from scratch**. The steward ([[agent-curator]]) dispatches a scoped doer
([[agent-reconciler]]) **per drifted unit**, seeded with that unit's scoped briefing
(`render.mjs agent-reconciler hub-<domain> --profile standard`) — one domain's closure, never the whole
vault — which edits in place. From-scratch authoring (a brand-new domain, a note that does not exist yet)
is **escalated**, not done by the loop.

**Why:** Regenerating a unit at a one-line change churns notes and can erase human edits. Incremental
reconciliation with scoped context is cheap, safe, and reviewable; full authoring is a deliberate human
act, not a nightly side-effect. For Synapse the common reconcile is **row → view**: a canonical row changed,
so regenerate its derived view ([[rule-derived-views-are-generated]]) — not rewrite the domain.

**How to apply:**
1. **Scope (doer)** — [[agent-reconciler]], seeded with `hub-<domain>`, edits only that unit (regenerate a
   stale view, fix that domain's notes). Minimal diff — what drifted, nothing else.
2. **Escalate from-scratch** — a new domain / a note that does not exist is not a reconcile; route it to
   `inbox/attention/` ([[rule-synapse-fail-loudly]]); a human initiates the authoring.
3. **Verify (steward, maker ≠ checker)** — [[agent-curator]] reviews the reconciler's diff (in-scope?
   single-sourced? schema-clean? no stray edits?), repairs the unambiguous, escalates the rest, re-runs
   `lint.mjs` to `errors=0`, then hands off human-gated ([[rule-synapse-human-gated-push]]). The doer that
   wrote the edit does not approve it.

Related: [[rule-synapse-fail-loudly]] · [[rule-synapse-single-source-of-truth]] · [[rule-synapse-human-gated-push]] · [[rule-derived-views-are-generated]] · [[loop-maintain-synapse]]
