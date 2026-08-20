---
id: decision-0009-agent-memory-from-waku
type: decision
title: "Agent memory & live context — adopt Waku's three-memory + gate model, deterministically, propose-only"
tags:
  - type/decision
  - area/runtime
  - status/active
related: ["[[doc-agent-memory]]", "[[decision-0003-human-gated-mutation]]", "[[decision-0005-hybrid-retrieval]]"]
---

**Status:** Accepted — 2026-08-19

## Context
A briefing is rendered ONCE, at dispatch, from `(agent, target, task)`. Agents then drift: ten turns
later the work has moved to a new subtask while the context is frozen at turn 1. Observed live — a lead
that "seemed to stop using its tools" was running on a stale turn-1 snapshot.

The mental model came from **Waku** (github ShenSeanChen/waku-agent), a local-first agent harness. Waku
splits memory into three pillars — **semantic** (durable facts), **episodic** (dated events / past runs),
**procedural** (skills, how to act) — and runs a **retrieval gate** before each turn ("does this message
need memory at all?") so irrelevant memories don't bias the answer. Mapping that onto synapse:

| Waku pillar | Synapse had | Verdict |
|---|---|---|
| procedural | agents + rules + skills (typed closure) | already stronger (typed, linted, role-based) |
| semantic | notes + `augment` embeddings | already had it |
| episodic | **nothing** | the real gap |

Two model differences matter. Waku is **single-user and self-writing** — an agent distills its own
`SKILL.md` and consolidates memories automatically, and a slightly-wrong personal fact costs little.
Synapse's vault is **team-shared and human-authored + linted** — an auto-written note becomes a
*briefing other agents trust*, which is exactly what [[decision-0003-human-gated-mutation]] gates.

## Decision
Adopt Waku's **mental model** (three memories + a gate) but implement it on synapse's terms:

1. **Add the missing pillar — episodic memory.** `synapse_history` / `synapse_log`, stored in its own
   `db/episodes.db` (primary data — never the rebuildable embeddings cache, never the lease DB). Delegated
   work records itself inside `synapse_claim_and_brief` + `synapse_spawn_release` (the two calls a
   delegation cannot skip), so it cannot be forgotten.
2. **Assemble context PER TURN, not once — `synapse_recall`.** Returns only the delta for the current
   subtask across all three memories, never the whole briefing.
3. **The gate is DETERMINISTIC and lives in the RESULT, not a per-turn model call.** Waku spends a cheap
   LLM call each turn on "need memory?"; synapse answers it from keyword matching (validated ~11/12 for
   hub/suite routing) and simply returns "nothing new" when nothing clears the bars. No model, offline,
   debuggable.
4. **Push what an agent cannot know to ask for; let it pull the rest.** On-demand notes carry a ~35-token
   trigger instead of a 6k-token body; the agent fetches the body when the situation applies. This is the
   session's through-line — **prefer the tool over the prompt** (a lease over "don't dupe", a trigger over
   an inlined rule, keyword routing over "pick the right hub"): a briefing advises, a mechanism guarantees.

## Explicitly NOT adopted (and why)
- **Auto-consolidation / an agent distilling durable facts unattended.** Waku does this for one user;
  on a shared, linted vault an auto-written note is normative context others trust, so it must be
  **propose-only** under [[decision-0003-human-gated-mutation]] — the same gate as `synapse_create_*`.
  Deferred, and if built at all, human-gated.
- **Per-turn LLM gate.** Replaced by the deterministic gate above — cheaper, offline, and testable.
- **The full LLM-Ops / eval loop** (Waku's trace → eval → gate → release). A separate project: it is
  fuzzy (an LLM judging an LLM) where everything here is deterministic and unit-tested, and an auto-eval
  that rewrites what agents are told is a feedback loop that can quietly drift the whole vault.

## Consequences
- (+) Synapse now holds all three memories and refreshes context as the task moves — the drift this
  started from is addressable by a cheap `synapse_recall` on each topic shift.
- (+) Episodic memory is a factual log (needs no review gate) and doubles as historical dedup: re-claiming
  a job that already ran surfaces `priorRun` — a warning, never a block.
- (+) The deterministic gate keeps the whole layer offline-capable and testable; no new model dependency
  on the hot path.
- (↔) The tools are inert unless an agent knows WHEN to call them, so a standing MEMORY brief is wired
  into every read MCP surface (and, per-vault, a `tool-*` note) — documented in [[doc-agent-memory]].
- (−) `synapse_recall` on a topic shift costs an embedding query + a keyword scan; cheap, but real. The
  first augmented launch after a vault edit also pays an incremental re-embed (behind a fleet lock).

## Related
[[doc-agent-memory]] — the feature reference · [[doc-mcp-tools]] — the tools by surface ·
[[decision-0003-human-gated-mutation]] · [[decision-0005-hybrid-retrieval]] · [[doc-semantic-recall]]
