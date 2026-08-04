---
id: decision-0008-addressable-vs-autonomous
type: decision
title: Split "standing" into two orthogonal agent capabilities — autonomous (own clock) and addressable (Buzz identity)
tags:
  - type/decision
  - area/governance
  - status/active
related: ["[[rule-agent-orchestration]]", "[[rule-buzz-reply-contract]]"]
---

**Status:** Accepted — 2026-08-03

## Context
The harness used one word — **standing** — for an agent that both (a) runs on its own clock and (b)
holds a Buzz identity a human can `@mention`. The two properties travelled together because the only
standing agents so far — oracle (read front door) and curator (steward) — happen to have both.

That coupling blocks a capability the owner wants: **observing agent-to-agent handoffs on Buzz.** Buzz
is the observation layer — its purpose is to make interaction visible so a human can supervise and
improve it. But the two doers, [[agent-reconciler]] and [[agent-ingester]], are dispatch-only: they act
only when handed a unit of work, never on their own clock. The harness-playbook cadence test (a role
earns "standing" only if it runs on its own clock) therefore denied them an identity — which is exactly
why their work is invisible. Delegation to them happens *inside* the orchestrator (a `Task` spawn) and
never appears in a channel.

So the single word conflates two things that are not the same question:

- **Does it run unprompted, on its own schedule?** (a *cadence* question)
- **Can it be summoned by name and watched replying in a thread?** (an *addressability* question)

An agent can be watchable without being self-running. There was no way to say that.

## Decision
Replace the implicit "standing" bit with **two orthogonal, declared frontmatter flags** on every agent
definition:

- **`autonomous: true`** — the agent runs on its own clock, unprompted (a conforming harness gives it a
  schedule / long-running process). *oracle, curator.*
- **`addressable: true`** — the agent holds a stable Buzz identity: it can be `@mention`ed and it replies
  in-thread (a conforming harness provisions an identity for it and keeps it reachable). *oracle, curator,
  reconciler, ingester.*

Both **default to `false`** — a new agent is neither self-running nor reachable until it declares
otherwise; a purely ephemeral `Task`-spawned helper declares neither.

| Agent | `autonomous` | `addressable` | reads as |
|---|---|---|---|
| oracle | `true` | `true` | self-running, watchable front door |
| curator | `true` | `true` | self-running, watchable steward |
| reconciler | `false` | `true` | **addressable doer** — summoned, but visible |
| ingester | `false` | `true` | **addressable doer** — summoned, but visible |

The **package declares the roster**; the harness consumes it. A conforming harness reads these flags
(surfaced through the agent registry) instead of a hand-maintained list of names — so adding a watchable
agent is a package edit, not a per-install re-wiring.

Two dependent rules follow from the flags:

- **Handoff channel is chosen by the target's `addressable` flag** ([[rule-agent-orchestration]]). Target
  is addressable → hand off **on Buzz** (`@mention` in-thread, then score its posted reply) so the
  handoff is visible. Target is not addressable → spawn quietly via `Task`, as before.
- **The reply contract keys on `addressable`, not on role** ([[rule-buzz-reply-contract]]). Any agent
  holding a Buzz identity (i.e. `addressable`) must publish its result to the channel every turn —
  including an addressable doer. A non-addressable helper reached via `Task` still returns to its
  orchestrator, which publishes.

`addressable` and `autonomous` stay independent of *authorization*: being watchable or self-running never
loosens the human gate on irreversible actions ([[rule-synapse-human-gated-push]]). A summoned doer still
proposes; it does not ship.

## Consequences
- (+) The owner can watch reconciler/ingester handoffs happen in a Buzz thread — the supervision loop the
  observation layer was built for.
- (+) "Addressable but not autonomous" is now expressible, so a doer earns visibility without pretending
  to have a cadence — the playbook's cadence test stays intact for `autonomous`.
- (+) The roster ships with the package: any future subagent becomes watchable by declaring one flag, with
  no harness-side edit.
- (↔) A conforming harness gains one responsibility: provision a Buzz identity for each `addressable`
  agent and schedule each `autonomous` one. The flags are the contract; the mechanism is the harness's.
- (−) More agents holding identities means more provisioned keys / reachable processes than a two-agent
  roster; bounded by the fact that flags are opt-in and default `false`.

## Related
[[rule-agent-orchestration]] · [[rule-buzz-reply-contract]] · [[agent-reconciler]] · [[agent-ingester]] · [[rule-synapse-human-gated-push]] · [[rule-no-unprompted-actions]]
