---
name: synapse-curator
description: Run a whole-vault maintenance pass as agent-curator — detect drift (lint errors, DB-to-view divergence, orphans, unprocessed inbox), autofix only the unambiguous, dispatch a reconciler per drifted unit, and open ONE human-gated PR. Use for vault health, hygiene, drift, cleanup, or "is the vault OK".
---

# Curator — maintain the whole vault

Detect drift, heal only what is unambiguous, delegate the rest, and stop at a reviewable PR.

## Procedure

1. **Check what was already done.** `mcp__synapse__synapse_history` — a maintenance pass that ran
   recently may already have handled this; repeating it produces a noisy duplicate PR.
2. **Load your role.** `mcp__synapse__synapse_brief` with `agent: "curator"` and the hub in scope
   (`hub-synapse` for the engine itself).
3. **Detect.** `mcp__synapse__synapse_lint` (`strict: true`) for mechanical health, and
   `mcp__synapse__synapse_embeddings_status` for a stale recall index. Read the whole report before
   changing anything — a fix chosen from the first error often conflicts with the fifth.
4. **Triage each finding into exactly one of three buckets:**
   - **Unambiguous** — exactly one correct fix (a broken wikilink whose target obviously moved, a
     missing `type/` tag). Fix it directly in `.md`.
   - **Drifted unit** — a stale derived view or a domain whose notes disagree with the DB. Delegate
     one reconciler per unit (see below); never regenerate the whole thing yourself.
   - **Ambiguous** — anything needing a judgement call about meaning. Escalate; do not guess.
5. **Verify.** Re-run `synapse_lint --strict`. The pass is done when errors are zero and nothing is
   left mid-flight — not when you have run out of ideas.
6. **Record it.** `mcp__synapse__synapse_log` with what you changed, what you escalated, and what you
   deliberately left alone.

## Delegating

Delegation is **three separate calls**. `synapse_claim_and_brief` does *not* start a worker — it only
takes the lease, opens the episode, and returns the briefing. You must launch the doer yourself.

1. **Claim the job first.** `mcp__synapse__synapse_claim_and_brief` with the specialist `agent` and a
   canonical `job` id built from stable facts (e.g. `reconciler:hub-finances:view-drift`). Use an agent
   that exists (`synapse_list_agents`); never invent one and never `synapse_create_agent` just to have a
   specialist. Without a claim there is no dedup and no durable record.
2. **Launch the doer with `run_in_background: false`.** Call the harness's `subagent` tool passing
   `prompt` = the briefing you just received + `"\n\n---\n\n"` + the task, and **`run_in_background:
   false`**. That argument is what makes the call WAIT and hand you the doer's answer as the tool result.
   Without it the call returns only `started subagent <id>` and no answer at all.
   - **Nothing spawns a worker but this call.** Do not poll `synapse_spawn_status` waiting for one to
     appear — that just burns the lease's TTL on a doer you never launched.
   - **Never call `job_output`, `job_list` or `job_kill` on a subagent id.** Subagents are not jobs; that
     lookup fails with `unknown job <id>`, and a failed lookup is **not** evidence the child finished.
   - **Never redo the doer's work yourself.** If the answer did not come back, release the job saying so
     and stop — a duplicated inspection costs more context than the whole delegation saved.
3. **Close it out.** `mcp__synapse__synapse_spawn_release` with the job/owner/token/spawnId/episodeId from
   step 1 and the doer's actual answer as the summary. The lease is what stops two passes reconciling the
   same unit at once; dropping the release breaks that guarantee.

If a claim comes back `refused: "held"` and you are the holder, you already own that lease — reuse its
`owner`/`token` and continue at step 2 rather than re-claiming under a new job id.

## Boundaries

- **Never write `db/synapse.db`.** Records change through a migration proposed in a PR, applied by a
  human. Never edit a `generated: true` view by hand — fix the source and regenerate.
- **One PR per pass, and a pass that changed nothing opens none.** Never self-merge, never force-push,
  never push to `main`.
- Worst case for an unattended run must be a reviewable diff, never a silent write.

## Working economy (applies to every step above)

- **Reach for vault content through the MCP tools, never the filesystem.** Fetch a note by id with
  `synapse_brief(note: "<id>")`; ids resolve without paths. The vault's layout is not what it looks
  like — decisions live under `_meta/`, records are generated views — so a guessed path fails, or worse
  returns a stale copy. Never `read`/`glob` vault content by hand.
- **Brief once per hub.** Re-briefing the same hub burns context and makes the answer worse on a local
  model. When the topic shifts, call `synapse_recall` for the delta instead.
- **Stop when the question is answered.** Extra tool calls are not extra diligence.
