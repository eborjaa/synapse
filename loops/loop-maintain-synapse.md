---
id: loop-maintain-synapse
type: loop
title: "Loop — maintain the Synapse vault (lint + DB↔view drift) until dry, PR the fixes"
tags:
  - type/loop
  - area/governance
  - status/active
owner: ""    # set this to your name/handle; the nightly canary resolves the display name from $VAULT_USER → `git config user.email` → a fallback
provenance: ["loop-engineering (detect → heal → verify, until dry)"]
goal: "Keep the whole Synapse vault schema-clean and its derived views current with the canonical DB, opening a reviewable PR of the fixes each pass — without turn-by-turn prompting."
exit_condition: "lint.mjs --strict = errors=0 AND no DB↔view divergence AND no inbox item awaiting action (dry). A pass that changed nothing opens NO PR. Hard budget cap per pass."
signal: "Per pass: (a) lint errors/warnings; (b) DB↔derived-view divergence (a canonical row changed, or a generated view was hand-edited); (c) orphans/broken links; (d) inbox/ items awaiting ingestion or human-resolved escalations."
pattern: "event-driven, loop-until-dry (detect → heal → verify)"
guardrails: "Edit ONLY .md + migration files under the vault — never write db/synapse.db directly, never edit a generated view by hand. Autofix only the unambiguous; escalate every judgment call to inbox/attention/ (rule-synapse-fail-loudly). Stage only what you touched (never git add -A); never force-push or rewrite shared history. Hand off by the per-repo/per-content policy (rule-synapse-human-gated-push, decision-0006-self-healing-vault): framework = human-gated PR (surface unresolved lint loudly in the PR body, never self-merge); vault Markdown/knowledge = direct push (self-healing); record/DB/migration changes = human-gated migration EVERYWHERE (the records DB is never self-healed). NO-SPIN: the trigger skips the curator's own synapse/curator-* maintenance commits."
owner_agent: "[[agent-curator]]"
skill: "[[skill-maintain-synapse]]"
delegates_to: "[[agent-reconciler]] — one scoped doer per drifted unit, seeded with hub-<domain>"
reconcile: "incremental, row → view — the curator detects + plans, dispatches agent-reconciler per unit to regenerate a stale derived view or make minimal note edits, then verifies the diff (maker != checker). It does NOT regenerate a domain from scratch; new-domain authoring is escalated."
trigger: "LOCAL nightly cron/launchd → maintain-synapse-cron.sh runs the curator via OpenCode (opencode run, local Ollama over Tailscale — NO API key, NO cloud). Manual run is the fallback."
cadence: "nightly — one pass if there is anything to do; one PR per non-dry pass"
state: "Last-seen marker = the latest commit on main whose subject matches 'curator: synapse maintenance <date>'. Audit trail = inbox/curator/logs/ (run-logs + LOG.md heartbeat); open escalations = inbox/attention/. Read both first, every pass."
---

> **A loop, not a one-shot lint:** each pass re-detects drift, heals the unambiguous, escalates the rest,
> and is *dry* when lint is clean, no view diverges from its row, and the inbox is clear. Owner:
> [[agent-curator]] — its briefing (`render.mjs agent-curator loop-maintain-synapse --profile standard`)
> carries the rules, tools, and conventions this loop relies on.

## When to run (trigger)
**Local nightly cron / launchd** → `maintain-synapse-cron.sh` runs the curator headlessly via **OpenCode**
(`opencode run`, local Ollama over Tailscale — no API key, no cloud — see
[[decision-0004-opencode-local-ollama-runtime]]). A dry night appends one `logs/LOG.md` line and exits. The
loop self-orients from `inbox/curator/` and the last-marker commit. A manual run is the fallback.

## The pass (one run)
1. **Orient** — read `inbox/attention/` + `inbox/curator/logs/` FIRST ([[rule-synapse-fail-loudly]]); action
   any human-resolved escalation; skim the latest run-log.
2. **Detect** — `lint.mjs --strict`; **DB ↔ derived-view divergence** (compare each generated view against a
   fresh render of its canonical row; flag hand-edited generated files); orphans / broken links; `inbox/`
   items; **stale top-level overview docs** (`README.md` / `TUTORIAL.md` / `AGENTS.md` lagging a
   framework-wide change — [[rule-framework-docs-current]]). (No code-drift detection — this vault is its
   own source of truth.)
3. **Dry gate** — lint `errors=0` AND no divergence AND nothing in the inbox → append `no-op — dry` to
   `logs/LOG.md` and **stop**. The common case; treat as success.
4. **Heal — reconcile, don't regenerate** ([[rule-synapse-incremental-reconcile]]) — mechanical lint autofixes
   in place; for each drifted unit, dispatch [[agent-reconciler]] (`render.mjs agent-reconciler hub-<domain>
   --profile standard`) to regenerate a stale view or make the minimal note edit. Stage only what changed.
5. **Verify (maker ≠ checker)** — the curator reviews each reconciler's diff; repairs the unambiguous;
   escalates over-reach. The doer never approves its own edit.
6. **Escalate** — anything ambiguous / destructive / authoring, or any DB write → a dated `inbox/attention/`
   note with Options, then stop on it ([[rule-no-unprompted-actions]]). A record change is proposed as a
   **migration** in the PR, never applied directly ([[decision-0003-human-gated-mutation]]).
7. **Re-lint** to `errors=0`; surface any unresolved error loudly.
8. **Hand off (only if something changed)** — by the per-repo/per-content policy
   ([[rule-synapse-human-gated-push]], [[decision-0006-self-healing-vault]]). **Framework:** fresh
   `synapse/curator-<YYYY-MM-DD>` off latest `main`, commit subject `curator: synapse maintenance
   <YYYY-MM-DD>` (the next marker), stage only what you touched (never `git add -A`), open a PR to `main`;
   never force-push, never push to `main`, never self-merge. **Vault:** push verified Markdown/knowledge
   directly (no PR); a record change is still proposed as a **migration** through the human gate, never
   applied directly ([[decision-0003-human-gated-mutation]]). A dry pass hands off nothing.
9. **Log** — a heartbeat line in `logs/LOG.md` (every pass); a per-pass note when the pass did something.

## Exit condition
**Dry = nothing to reconcile** — a valid, common outcome; treat as success, not a reason to act. No
reconciler, no edits, no PR — just a `no-op — dry` heartbeat. Hard budget cap per pass regardless.

## Harness mapping
Local cron / launchd → `maintain-synapse-cron.sh` → `opencode run` runs [[skill-maintain-synapse]] on local
Ollama (no API key) · per-unit scoped sub-agent = [[agent-reconciler]] seeded with `hub-<domain>` · the
last-maintenance commit + `inbox/curator/logs/` = external memory. The pass also runs `gen-embeddings.mjs`
(incremental, after `gen-index.mjs`) to keep the generated `note_vectors` table fresh for semantic recall
([[doc-semantic-recall]]); if Ollama is unreachable it skips with a clear message and never blocks the pass.

## Related
[[agent-curator]] · [[agent-reconciler]] · [[skill-maintain-synapse]] · [[doc-maintainer-loop]] · [[rule-synapse-fail-loudly]] · [[rule-synapse-incremental-reconcile]] · [[rule-synapse-human-gated-push]] · [[rule-framework-docs-current]] · [[decision-0003-human-gated-mutation]] · [[decision-0006-self-healing-vault]] · [[decision-0004-opencode-local-ollama-runtime]] · [[tool-render]] · [[tool-lint]] · [[tool-git]] · [[tool-gh]]
