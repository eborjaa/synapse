---
id: doc-maintainer-loop
type: doc
title: The maintainer loop — what changed from the source pattern
tags:
  - type/doc
  - area/architecture
  - status/active
references_docs: ["[[conventions]]"]
related: ["[[hub-synapse]]"]
---

# The maintainer loop

Synapse ports the source pattern's maintenance spine wholesale, then changes the one thing that must change:
**there is no external code to chase.** This wiki *is* the source of truth, so the loop detects drift
*within* the vault, not between docs and an upstream app.

## The spine (ported unchanged)
**Orient** on `inbox/` first (action any human-resolved escalation) → **dry-gate** (nothing to do → log a
`no-op — dry` heartbeat and stop; the common case, and it counts as success) → **heal** (mechanical
autofix directly + dispatch a scoped [[agent-reconciler]] per drifted unit + **maker ≠ checker** verify of
its diff + escalate from-scratch authoring) → **escalate** the rest to `inbox/attention/` with Options and
stop → **re-lint** to `errors=0` → **hand off by the policy that fits the repo and content type**
([[rule-synapse-human-gated-push]]) → **log** a heartbeat. On the framework, the handoff is a human-gated
PR (fresh branch off latest, never force-push, never push to the shared branch, never self-merge); on the
private vault, verified Markdown is pushed directly while record changes still ride the human migration
gate ([[decision-0006-self-healing-vault]]).

## What changed — the detect signal and the reconcile target
The source pattern detects **code merged to a branch** and reconciles **docs → code**. Synapse has **no
external code** — so there is no code-drift detection. Its drift signals are:

1. `lint.mjs --strict` violations (schema, links, secrets, fences).
2. **DB ↔ derived-view divergence** — a canonical row changed but its Markdown view is stale, or a
   generated view (or the `.md` index) was hand-edited.
3. Orphans / broken links.
4. `inbox/` items awaiting ingestion.
5. **Stale top-level overview docs** — `README.md` / `TUTORIAL.md` / `AGENTS.md` left describing an old
   reality after a framework-wide change ([[rule-framework-docs-current]]). They carry no frontmatter, so
   nothing mechanical guards them; the curator treats lagging overviews as a reconcile target, not an
   out-of-scope file.

The reconcile mapping is **row → view** (not "code → doc"): when a canonical row changed, regenerate its
derived view; when a generated artifact was hand-edited, escalate it. The **migration gate** handles the
*other* direction — changes flowing *into* the DB ([[decision-0003-human-gated-mutation]]). Together:
migrations write the DB (human-gated), the reconciler keeps the views current (human-gated).

## Trigger & runtime
A local nightly job (cron / launchd) wakes the [[agent-curator]] on the **OpenCode** runtime
([[decision-0004-opencode-local-ollama-runtime]]) — local Ollama over Tailscale, no API key. The durable
"since last run" marker is the last maintenance commit (fallback: the last commit touching the vault). The
audit trail is `inbox/curator/logs/` (LOG.md heartbeat + per-pass notes). A dry night logs one line and
exits.

## Unchanged guardrails
Dry-gate-as-success · fail-loudly · autofix-only-the-unambiguous · escalate-with-Options-and-stop ·
maker ≠ checker · never `git add -A` (stage only what you changed) · never force-push or rewrite shared
history. The **handoff** follows the per-repo/per-content policy ([[rule-synapse-human-gated-push]]): a
human-gated PR on the framework; a direct push for vault Markdown; the human migration gate for record/DB
changes everywhere.

## Related
[[loop-maintain-synapse]] · [[doc-governance-model]] · [[agent-curator]] · [[agent-reconciler]] · [[rule-synapse-human-gated-push]] · [[decision-0003-human-gated-mutation]] · [[decision-0006-self-healing-vault]] · [[decision-0004-opencode-local-ollama-runtime]] · [[hub-synapse]]
