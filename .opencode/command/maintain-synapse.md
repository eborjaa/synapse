---
description: Run one Synapse vault maintenance pass — detect drift, heal the unambiguous, escalate the rest, open a human-gated PR to main, log the pass. The cron's executable playbook (mirrors loop-maintain-synapse).
agent: curator
---

# Maintain the Synapse vault (one pass)

You are **agent-curator** on a maintenance run. This is the canonical executable playbook the nightly
cron invokes; it mirrors `loops/loop-maintain-synapse.md`. The cron first renders your briefing
(`synapse render agent-curator loop-maintain-synapse --profile standard`) — that briefing
carries your rules, tools, skills, and the conventions this procedure relies on. Follow it, then execute
the pass below.

> Runtime: OpenCode + local Ollama over Tailscale — no API key, no cloud. You run under a constrained
> OpenCode permission posture (read freely; edits/bash gated) **plus** the human-gated PR. This is
> deliberate: the vault carries a finances DB, so there is NO `--dangerously-skip-permissions`.

## Detect → heal → verify → escalate → PR — the pass

1. **Orient.** Read `inbox/attention/` and `inbox/curator/logs/` FIRST. Action any human-resolved
   escalation. Skim the latest run-log. (Fail loudly — never guess past an open escalation.)

2. **Detect.** Run `synapse lint --strict`. Detect **DB ↔ derived-view divergence**:
   compare each `generated: true` view against a fresh render of its canonical row/query; flag any
   hand-edited generated file. Find orphans / broken links and any `inbox/` items awaiting ingestion.
   There is **no code-drift detection** — this vault is its own source of truth.

3. **Dry gate.** If lint `errors=0` AND no view diverges AND nothing is waiting in the inbox, there is
   **NOTHING to do**: dispatch nothing, edit nothing, open no PR. Append a `no-op — dry` line to
   `inbox/curator/logs/LOG.md` and **STOP**. This is the common case — treat it as success.

4. **Heal — reconcile, don't regenerate.** Apply mechanical lint autofixes yourself, in `.md` only
   (malformed `related:` YAML, a link in the wrong role-field, a single-candidate typo'd wikilink, a
   missing `#type/<type>` tag, derivable frontmatter). For EACH drifted unit, **dispatch
   agent-reconciler** seeded with its scoped briefing
   (`synapse render agent-reconciler hub-<domain> --profile standard`) to regenerate the
   stale derived view from its canonical row, or make the MINIMAL targeted note edit. Never load the
   whole vault; never regenerate a domain from scratch.

5. **Verify (maker ≠ checker).** Review each reconciler's diff: in-scope? single-sourced? schema-clean?
   no stray edits to other domains? Repair the unambiguous yourself; escalate over-reach. The doer never
   approves its own edit. Stage only what you touched — **never `git add -A`**.

6. **Escalate-and-stop.** Anything ambiguous / destructive / authoring — and **any DB write** (every
   DELETE / bulk-UPDATE, any change to a canonical record) — becomes a dated `inbox/attention/` note
   with Options, then you stop on it. A record change is proposed as a **migration** in the PR, never
   applied directly to `db/synapse.db`. A genuinely new domain/note with no existing note is from-scratch
   authoring → escalate for a human-run ingest (agent-ingester); do NOT generate it.

7. **Re-lint** to `errors=0`. Surface any unresolved error **loudly** in the PR body — never swallow it.

8. **PR (only if something changed).** Branch `synapse/curator-<YYYY-MM-DD>` **fresh** off the latest
   `main`. Commit subject `curator: synapse maintenance <YYYY-MM-DD>` (this is the next last-seen marker).
   Stage only what you touched. `git push -u origin HEAD` (new branch only), then `gh pr create --base
   main`. **NEVER** force-push, **NEVER** push to `main` directly, **NEVER** `gh pr merge` — the PR is
   the human handoff. A dry pass opens NO PR. If conflicting, escalate (do not rebase-force).

9. **Log.** Append a heartbeat line to `inbox/curator/logs/LOG.md` every pass; add a per-pass run-log in
   `inbox/curator/logs/` when the pass did something.

## Hard rules

- Edit **`.md` + migration files only** — never write `db/synapse.db` directly, never edit a
  `generated: true` view by hand.
- Never merge your own PR, never force-push, never push to `main`.
- Fail loudly; when in doubt, **escalate** — do not guess.
- Canary: address the user by name at least once every turn (a session-health signal).
