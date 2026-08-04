---
id: rule-agent-orchestration
type: rule
title: Agent orchestration — claim-or-delegate, score, re-delegate
tags:
  - type/rule
  - status/active
related: ["[[hub-synapse]]"]
---

# Agent orchestration — claim-or-delegate, score, re-delegate

**Rule:** An orchestrator handles a task itself only when it matches its own `purpose`; otherwise it
delegates to the best-fit agent it can spawn, **scores** the result, and re-delegates until the task is
done or a bounded budget is spent — never more than one delegation level deep.

## The loop

1. **Claim or delegate.** Compare the task to your own `purpose`. If it is yours, do it with your tools.
   If not, call the vault MCP's `synapse_list_agents`, read each agent's `purpose`, and pick the
   single best fit. Never hardcode who does what — the registry is the source.
2. **Hand off — the channel is chosen by the target's `addressable` flag**
   ([[decision-0008-addressable-vs-autonomous]]). Read the picked agent's flags from the registry:
   - **`addressable: true` → hand off on Buzz (visible).** Open a fresh thread and `--mention` the agent
     on the channel, handing it only the context it needs; it replies in-thread
     ([[rule-buzz-reply-contract]]). The handoff is watchable — this is the default when the target is
     addressable, so a human can supervise the interaction.
   - **`addressable: false` → spawn quietly via `Task`.** Spawn it as a subagent (Claude Code Task tool)
     **by its name**; it runs with the full synapse toolset and its own vault-rendered role and returns
     its result to you.
   Either way, hand it the task plus only the context it needs, and never more than one level deep.
3. **Score the result.** Judge what it returns — its in-thread Buzz reply, or its `Task` return value —
   and be explicit about which mode you used:
   - **Qualitative (default).** Does the result satisfy the task as stated — grounded and cited, inside the
     agent's remit, no overreach, no fabrication?
   - **Quantitative (when the agent's design defines a signal).** If the delegated agent's role names a
     concrete success condition — a doer whose contract is "lint clean", "view regenerated", "row written"
     — verify that signal literally (re-run `synapse_lint`, re-read the unit) and let it decide the score.
     The available agents' designs, not this rule, determine when a quantitative check exists.
4. **Pass or re-delegate.** Pass → report to the user, citing what was done and how you scored it. Fail →
   re-delegate: the same agent with specific feedback, or the next best-fit agent, until it passes or the
   **attempt budget (default 3)** is spent — then report the partial result and the blocker honestly.

## Boundaries — fail loudly

- **One level only.** A spawned subagent must never spawn another orchestrator; keep the tree one deep.
- **Maker ≠ checker.** The agent that did the work never scores its own pass — the orchestrator scores it.
- **Delegation moves work, not authorization.** Irreversible actions (commits, DB writes, tickets) still
  stop for the human ([[rule-synapse-human-gated-push]]); a subagent proposes, it does not ship.
- **No forced fit.** If no agent's `purpose` matches, say so and ask the human — do not delegate to a poor fit.

## Related
[[hub-synapse]] · [[rule-synapse-human-gated-push]] · [[agent-curator]]
