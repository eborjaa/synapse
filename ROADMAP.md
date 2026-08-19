# Synapse — roadmap & what's left

Status as of 2026-08-19 (branch `feat/embeddings-freshness`, versions 0.11–0.15, unpublished).

## The through-line: prefer the tool over the prompt

Every feature that stuck this session replaced *advice in a briefing* with *a mechanism in code*:

| Instead of a briefing that says… | …we built a tool that enforces it |
|---|---|
| "don't double-dispatch the same job" | a SQLite lease (durable-spawn) |
| "always follow all your rules" (a 6k-token inlined rule) | on-demand notes: a ~35-token trigger, body fetched when it applies |
| "pick the right hub / suite for this task" | deterministic keyword routing (hub inference, suite affinity) |
| "remember what you already did" | episodic memory (recorded by the calls a delegation can't skip) |
| "your briefing might be stale" | recall: the delta for the current subtask, on demand |

A briefing *advises*; a tool *guarantees*. Advice depends on the model getting it right every time;
a mechanism does not. **This is the design axis to keep steering by.**

## Shipped this session (0.11 → 0.15)

- **0.11 Index freshness** — a stale embeddings index is now loud and self-healing (was silent).
- **0.12 Episodic memory** — `synapse_history` / `synapse_log`; delegated work records itself; historical dedup.
- **0.13 On-demand notes** — `on_demand: true` + `trigger:` render a pointer, not the body.
- **0.14 `synapse_recall`** — the top-up when the task shifts; a built-in gate; unifies all three memories.
- **0.15 Suite-affinity routing** — recall biases toward a suite the task names (fixes the alerts/sensors mixup).
- **Standing MEMORY brief** — wired into the MCP server (every vault) and every REL agent, so the tools get *used*.

156 tests, an MCP e2e (full delegation loop + adversarial inputs), smoke on all surfaces, lint clean.

## Next — the execution layer (the real direction)

Synapse so far is a **context layer**: it makes an agent better-informed. An informed agent is still an
LLM and can still execute wrong. The next layer is **agnostic execution tools** that take a briefing's
*intent* and produce the result deterministically — correctness stops depending on the model.

The method is not "replace briefings with tools." It is to draw the line deliberately:
- **Mechanical, repeatable, one-right-answer** (formatting, dedup, sequencing, validation) → extract into
  a tested tool. The briefing shrinks to "call this tool."
- **Judgment** (what to prioritize, when to escalate, how to interpret) → stays in the briefing, where
  being hard to hard-code is a feature, not a bug.

**First candidate: the Zephyr comment format.** It is a template — a function waiting to happen:
`formatZephyrComment(data) → html`, unit-tested, no model variance. Today it lives as a 4.4k-token
on-demand doc the agent is trusted to apply by hand; a tool would guarantee the output. Harvesting it is
the pattern for everything else: watch what agents repeatedly do *from* a briefing, and lift the
mechanical core into a tool.

## Deferred (planned, not started)

- **LLM-Ops / briefing quality loop** — a SEPARATE project. Observe (token/trim/recall metrics on real
  briefings) → Diagnose (dead-weight notes vs recurring gaps) → propose vault changes, human-gated. The
  Observe/Diagnose phases are deterministic and cheap and could ship first; an LLM-as-judge eval is the
  speculative, expensive tail and should not be built before the observability underneath it exists.
  Note the tension with the axis above: an auto-eval that rewrites what agents are told is a feedback
  loop that can quietly drift the whole vault — build it, if at all, with strong human gates.
- **Auto-consolidation of episodes** — distill a week of episodes into a proposed handover note.
  Waku does this fully-automatically for a single user; for a team-shared, linted vault it must be
  propose-only (the trust model behind `synapse_create_*`).
- **Multi-hub — DROPPED.** Tested and unnecessary: `recall` covers cross-domain work on demand, better
  than stacking two hubs up front (verified — an agent briefed on one suite recalls the others cleanly).

## Consumer wiring (REL vault, separate repo)

`reliability/context-eb` is installed on synapse ≥ 0.15: the manifest fix (rules reach every briefing),
the split Zephyr rule + on-demand template, and `tool-synapse-context` wired into all 14 agents. Not yet
rolled to the live `reliability/context` vault (Javier's — awaiting his call). npm publish is held.
