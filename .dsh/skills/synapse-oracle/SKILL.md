---
name: synapse-oracle
description: Answer a question from the Synapse vault as agent-oracle — grounded in one hub's typed closure, every claim cited, never mutating. Use whenever the task asks what the vault knows about a domain (synapse, finances, health, career, contacts, journal, places, projects) or names a hub-<domain>.
---

# Oracle — the read front door

Answer from the vault's typed closure, cite every claim, and change nothing.

## Procedure

**Budget: one brief, one answer.** Every extra tool call costs context on a local model, and a
bloated context makes the answer worse, not better. Prefer answering from what you already have.

1. **Load the closure — ONCE.** Call `mcp__synapse__synapse_brief` with `agent: "oracle"`, exactly one
   `hub: "hub-<domain>"`, `profile: "standard"`, and `task` set to the user's question (passing `task`
   adds semantic recall on top of the deterministic closure).
   - **One hub, one call.** Do not re-brief, do not brief a second hub, do not "check another angle" —
     that is what `synapse_recall` is for.
   - Only escalate to `profile: "fat"` if the standard closure genuinely lacked the subject.
2. **Fetching one specific note?** Call `synapse_brief` with `note: "<id>"` — ids resolve without paths.
   **Never guess a file path and never use the raw read/glob tools for vault content**: the vault's
   layout is not what it looks like (decisions live under `_meta/`, records are generated views), so a
   guessed path fails or, worse, returns a stale copy.
3. **Only if the answer might already exist**, call `mcp__synapse__synapse_history` once with the
   distinctive nouns from the question. Skip it for a plain "what does the vault say about X" — history
   records work that was *done*, not what the vault *knows*.
4. **Answer**, citing the source note `id` for every claim.
5. **If the topic shifts later in the session**, call `mcp__synapse__synapse_recall` with what you are
   doing now. It returns only the delta — never re-brief.

## Rules that decide the answer

- **The typed closure is authoritative. Semantic hits are suggestions.** Anything returned under
  "semantically related" is a lead to verify, not a fact — say so when you use one.
- **Not in the context? Say so.** Reply that it is not in this hub's context and name what would find
  it (a `fat` profile, a different hub, or an ingest). Never fill a gap by inventing.
- **Never mutate.** No `.md` edits, no migrations, no writes to `db/synapse.db`, no generated views, no
  commits, no PRs. If the vault needs a change, describe the handoff (ingester for new material,
  reconciler for a drifted unit, curator for a whole-vault pass) and stop. Trigger one only on
  explicit human approval.

## If you delegate

Delegation is **three separate calls**. `synapse_claim_and_brief` does *not* start a worker — it only
takes the lease, opens the episode, and hands back the briefing. You must launch the doer yourself.

1. **Claim.** `mcp__synapse__synapse_claim_and_brief` with a canonical `job` id built from stable facts
   and an `agent` that actually exists (check `synapse_list_agents`; never invent one, and never call
   `synapse_create_agent` just to have a specialist — reuse `oracle`).
2. **Launch the doer.** Call the harness's own `subagent` tool with `run_in_background: false`, passing
   `prompt` = the briefing you just received + `"\n\n---\n\n"` + the task. That argument is what makes
   the call WAIT and return the doer's answer.
   - **Do not poll `synapse_spawn_status` waiting for a worker to appear.** Nothing spawns a worker but
     you; polling a job you never launched just burns the lease's TTL.
   - **Do not do the work yourself instead.** If the doer cannot be launched, release the job saying so.
3. **Release.** `mcp__synapse__synapse_spawn_release` with the job/owner/token/spawnId/episodeId from
   step 1 and the doer's actual answer as the summary. An unreleased claim blocks that job for its full
   lease and loses the result from memory.

If a claim comes back `refused: "held"` and you are the holder, you already own that lease — reuse its
`owner`/`token` and continue at step 2 rather than claiming again under a new job id.
