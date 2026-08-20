---
id: doc-agent-memory
type: doc
title: "Agent memory & live context — freshness, episodic, on-demand, recall, suite-routing, handover"
tags:
  - type/doc
  - area/runtime
  - status/active
references_docs: ["[[conventions]]", "[[doc-semantic-recall]]", "[[doc-cli-reference]]"]
related: ["[[hub-synapse]]"]
---

# Agent memory & live context

A briefing is rendered **once**, at dispatch, from `(agent, target, task)`. Ten turns later the agent has
moved to a new subtask with its context frozen at turn 1 — the root cause of drift. This layer keeps an
agent's context **live** and gives it the three kinds of memory an agent stack needs. Design axis
throughout: **prefer the tool over the prompt** — a briefing *advises*, a mechanism *guarantees*.

## The three memories

| Memory | Holds | Surface |
|---|---|---|
| **Procedural** — how to act | agents, rules, skills | typed notes, walked by `render` |
| **Semantic** — what is true | your notes | typed notes + `augment` embedding recall |
| **Episodic** — what already happened | run history | `synapse_history` / `synapse_log` |

## Feature reference

### 1. Embeddings freshness — a stale index is loud, not silent (v0.11)
A *missing* index was always loud; a *stale* one was silent — recall ranked against an old vault with no
signal. Now `augment` checks freshness, refreshes incrementally when behind, and when it cannot (offline
Ollama, `SYNAPSE_NO_REFRESH`, a rebuild already running) says so **in the briefing**:
`> ⚠ semantic index is 42 note(s) behind the vault — run \`synapse embeddings\``.
- `synapse embeddings-status [--json] [--refresh] [--fast]` — ask any time.
- MCP: `synapse_embeddings_status` (reports `staleCount`), `synapse_embeddings_rebuild` (detached).
- Freshness compares each note against the mtime STORED in `note_vectors`, not the DB file's mtime (an
  incremental run that does nothing writes nothing, so the file mtime never advances — that approach
  loops forever). A two-tier check keeps it cheap: stat-only (~25ms) then an exact per-note pass (~400ms)
  only when inconclusive. A cooperative lock (`db/.embed.lock`) collapses a fleet's simultaneous rebuilds
  into one. `synapse setup` now builds the index instead of leaving it absent behind a `✅ GO`.

### 2. Episodic memory — synapse remembers what agents did (v0.12)
- `synapse_history({query, agent?, hub?, outcome?, sinceDays?})` — search completed work. Keyword (FTS5),
  so exact ids (`REL-38837`) match reliably. An empty result means NOT RECORDED, not "never happened".
- `synapse_log({task, summary, refs})` — record work you did yourself (read-only surface: it records a
  fact, authors no vault content).
- **Delegated work records itself**: an episode opens inside `synapse_claim_and_brief` and closes inside
  `synapse_spawn_release` — the two calls a delegation cannot skip, so memory can't be forgotten. It
  opens at CLAIM time, so work that dies mid-flight still leaves a record.
- **Historical dedup**: re-claiming a job that already ran returns `priorRun` (its outcome + summary). It
  WARNS, never blocks — a deliberate re-run is legitimate; an unknowing one is the waste worth naming.
- Stored in `db/episodes.db` — its OWN file, never `db/synapse.db` (a rebuildable embeddings cache any
  `--all` may discard) and never `db/durable-spawn.db` (leases; the fix for a stuck lease is deleting it).

### 3. On-demand notes — carry the trigger, fetch the body (v0.13)
A note (usually a rule or doc) can declare, in frontmatter:
```yaml
on_demand: true
trigger: "before posting a Zephyr execution comment"
```
`render` then emits a ~35-token pointer under a **"Fetch before you act"** checklist in every profile
instead of the body. The failure this fixes is not "agent forgot a rule it could see" but "agent never
knew the rule existed" — so a trigger, which names a SITUATION, is the right shape. A 6,000-token
formatting template becomes one line the agent can't miss; the body is fetched only when it applies.
- **Fetch it** with `synapse_brief(note: "<id>")` (MCP) or `synapse render <id>` — asking for a note by
  id renders its full body.
- Triggers are **sticky to a fixpoint**: an on-demand note referenced by anything already in the closure
  joins it regardless of hop distance (a rule at depth 1 that says "fetch X" must land X's trigger too),
  and a chain (checklist → template, both on-demand) resolves fully.
- Never budget-trimmed; `on_demand` outranks `mandatoryFull` ("always included" and "always inlined" are
  different claims — a binding template is best read fresh, not recalled).

### 4. `synapse_recall` — top up when the task shifts (v0.14)
`synapse_recall({task, k?})` returns only the DELTA for the current subtask — never the whole briefing —
unifying the three memories:
- **semantic** — notes relevant to the subtask (embedding recall),
- **procedural** — on-demand rules the subtask triggers (deterministic keyword match — offline, no model),
- **episodic** — whether it was already done (`synapse_history`).

The **gate is the return value**: nothing above the bars → *"Nothing new — your current briefing already
covers this"*, not filler. Call it whenever the topic shifts; it is cheap, and a stale briefing is how
agents drift. `lib/recall.mjs` exposes `recall()` and `triggeredRules()` directly.

### 5. Suite-affinity routing (v0.15)
When a task NAMES a suite (its `suite/<x>` tag vocabulary appears in the task text), recall biases its
hits toward that suite. Raw cosine could rank an adjacent suite higher — an "alerts" task returning
*sensors*-notification notes because both mention notifications. A soft boost corrects the ORDER without
hard-filtering (a real cross-suite note still surfaces); `routedToSuites` is returned so a wrong route is
visible. Deterministic and index-independent — the same keyword family used everywhere here.

### 6. Boot an agent FROM a handover (v0.16)
A handover note IS a task. `synapse handover-task <ref> [--plain]` (CLI), `synapse augment <agent>
--handover <ref>` (engine), the launcher `--handover` flag, and `synapse_resume_from_handover` (MCP) all
resolve a note (a path anywhere incl. a skipDir like `journal/`, or a fuzzy slug in `inbox/handovers/`),
strip its frontmatter, prepend the successor protocol ("read it first, confirm locked decisions, resume
from Next actions, reconcile against the vault"), and use the text as the task + recall query. One shared
core (`lib/note-as-task.mjs`), so the four surfaces cannot diverge. See [[doc-cli-reference]] for the full
launcher grammar, including composing a handover with an inline steering comment.

## The standing MEMORY brief
The tools are inert unless an agent knows WHEN to reach for them. Every read MCP surface
(`standard`/`full`/`orchestrator`) carries a short standing brief: call `synapse_recall` on a topic
shift, fetch an on-demand note when its trigger matches, check `synapse_history` before repeating work.
A consumer vault can add the same as a `tool-*` note wired into each agent's `uses_tools`.

## Vault resolution (which vault a command uses)
Interactive tools resolve **cwd-first** (v0.16.1): the vault you `cd` into wins, and an exported
`$SYNAPSE_VAULT` is a FALLBACK used only when cwd is not inside a vault — a stale rc export can no longer
silently override the vault you are standing in. The **MCP server** is the deliberate exception: it is
config-pinned (`.mcp.json` sets `$SYNAPSE_VAULT`) and cannot `cd`, so its env wins (`preferCwd: false`).

## Related
[[hub-synapse]] · [[doc-semantic-recall]] · [[doc-cli-reference]] · [[conventions]]
