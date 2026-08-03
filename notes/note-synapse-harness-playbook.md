---
id: note-synapse-harness-playbook
type: note
title: Synapse harness playbook — vault + MCP + standing-agent patterns
tags:
  - type/note
  - area/synapse
  - status/active
related: ["[[hub-synapse]]", "[[note-synapse-mcp-backlog]]"]
---

# Synapse harness playbook — vault + MCP + standing-agent patterns

Patterns for building a **Synapse-style setup**: a knowledge **vault**, an **MCP** surface over it, and a
small cast of **standing agents** (the harness) that read and act on it. Distilled from studying one real
instance — a chat-driven QA factory — but written to hold for **any** domain vault (career, health,
finances). QA is the worked example, **not** the subject; each pattern names its QA instance and then
generalizes.

Provenance: distilled from studying one real chat-driven QA software factory. No proprietary content —
patterns, not suites.

**How to read each pattern:** one-line rule · *context* · *the move* · *why it holds* · *smell you need it*
· *worked instance (QA)* · *backlog hook* (→ a tool idea in [[note-synapse-mcp-backlog]]).

## P1 — Keep the knowledge vault and the operating harness separate; let MCP be the only bridge

- **Context.** Any setup where a content vault (notes, rules, domain knowledge) is driven by standing agents.
- **The move.** Content lives in the **vault** — version-controlled, shareable. The **harness** that runs
  agents (scripts, service units, keys) is separate personal infra. Neither's files belong in the other.
  Agents *read* the vault only through an **MCP server** — and that server is the one thing allowed to ship
  *inside* the vault, because it ships with the content it serves.
- **Why it holds.** The vault stays portable and shareable without dragging machine-specific infra along;
  the harness can be rebuilt or swapped without touching knowledge. Agents get one typed surface instead of
  N ad-hoc file reads.
- **Smell you need it.** Agents reading vault files by absolute path; infra configs committed into the
  knowledge base; you can't hand someone the vault without leaking your machine setup.
- **Worked instance (QA).** A QA-suite vault (workflows, traceability) driven by a factory of scripts and
  services; the factory reads the vault through a `*-mcp` server living in the vault's `_meta/mcp/`.
- **Generalizes to.** Any domain vault with its own MCP + harness. QA is just the first instance.

## P2 — Give a chat identity only to agents you actually address; spawn the rest on demand

- **Context.** A multi-agent harness where you talk to some agents in channels.
- **The move.** Only the coordinators you `@mention` get a **standing identity** (keys, membership, a running
  service). Every other worker is **ephemeral** — spawned in-process from an agent-definition file when
  needed, with no identity and no service.
- **Why it holds.** An addressable name is the only thing a mention requires. Fewer identities means fewer
  keys, services, and processes to keep alive, secure, and rotate. Proven by deleting every worker identity
  and confirming a coordinator still spawned its workers, each self-briefing first.
- **Smell you need it.** You register a service and identity for an agent no human ever addresses; your
  registered-agent list grows faster than your channel list.
- **Worked instance (QA).** A release-QA lead and a vault-hygiene manager stand; ten doers (triager,
  spec-builder, reviewer…) spawn as subagents with no relay identity.
- **Backlog hook.** None — this is an org pattern, not a tool.

## P3 — Split standing roles by cadence, not convenience

- **Context.** Deciding which roles deserve to be standing agents versus subagents.
- **The move.** A role becomes **standing** when it runs on its **own clock**, independent of the others. A
  role that only ever runs inside another's task is a subagent, not a peer.
- **Why it holds.** A hygiene/maintenance role can't be a subagent of a release-scoped lead — it must run
  even when no release is active. Cadence, not org-chart tidiness, decides. (Corollary: two standing agents
  that *always* run together and never independently should collapse into one.)
- **Smell you need it.** You made X a subagent of Y, but X needs to run while Y is idle; or two standing
  agents never run apart.
- **Worked instance (QA).** Release-lead (per-release), vault-manager (its own hygiene cadence),
  platform-operator (always-on). Three clocks → three agents.
- **Backlog hook.** → a heartbeat/cadence tool that fires a standing agent's periodic job.

## P4 — One conversation scope per domain slice; derive context from the scope's name

- **Context.** Routing many domains through one chat surface.
- **The move.** One channel = one domain slice. The standing agent **derives its domain from the channel
  name** and loads that domain's hub/index into its briefing. No hardcoded per-domain config.
- **Why it holds.** The channel name is already the routing key. Reading it means *adding a domain = adding
  a channel*, not editing agent config.
- **Smell you need it.** Agents with hardcoded domain paths; adding a domain requires a code change instead
  of creating a channel.
- **Worked instance (QA).** One channel per suite; the lead reads `suite=` from the channel name and fuses
  that suite's map-of-content into its briefing.
- **Backlog hook.** → a `list-slices` / `brief-slice` tool that mirrors scope→hub without hardcoded paths.

## P5 — Verify with a fact ladder: cheapest check first, stop at the first red

- **Context.** Proving a harness actually works, auditable by a human who didn't watch it run.
- **The move.** Order checks from the cheapest static one up to full end-to-end. **Each level's pass
  condition is a fact** — an exit code, a row count, a log line, a file on disk — never an impression. Order
  so that a red at level N makes N+1 meaningless, and **stop at the first red**.
- **Why it holds.** Facts are auditable after the fact; cost-ordering surfaces failures at the cheapest
  possible point instead of after an expensive end-to-end run.
- **Smell you need it.** "Seems to work" as a pass condition; running the expensive e2e test before the
  static checks that would have caught the failure for free.
- **Worked instance (QA).** L0 static (no agents) → … → L8 end-to-end nested subagent; each level writes one
  line of evidence.
- **Backlog hook.** → the doctor/health tool in P7.

## P6 — Humans own the invariants and irreversible actions; agents work between them

- **Context.** Letting agents act without letting them do damage.
- **The move.** Agents propose and perform **reversible** work; a human owns anything **irreversible or
  invariant-defining** — commits, ticket writes, CI, schema changes. Write-path tools **write a file and
  stop**; they never fire git/CI/tickets on their own. Handover is human-triggered.
- **Why it holds.** It keeps a fast agent loop safe: the maker/checker split and "propose by default" make
  every consequential change a human-gated diff. (This very playbook was created by an MCP tool that
  proposes first and writes only on `write:true`.)
- **Smell you need it.** An agent that commits, files tickets, or mutates prod without an explicit ask; a
  "write" tool that also pushes.
- **Worked instance (QA).** The MCP's `handover_write` writes a note and stops — you commit it; no git/Jira/
  CI fires from any tool.
- **Backlog hook.** → side-effect tools (tickets, CI) gated behind an explicit ask, named in the dispatch.

## P7 — Build a doctor that catches silent failures — and make it tell "down" from "absent"

- **Context.** A stack where every process can look alive while being broken.
- **The move.** A runtime-aware health probe that checks **facts**: port open, vector index non-empty,
  prompt source correct, agent is a channel member, the right runtime binary is on PATH. Critically, it must
  distinguish **"dependency unreachable"** from **"thing missing"** — or it cries wolf.
- **Why it holds.** Liveness ≠ usable. A probe that conflates the two sends you fixing the wrong thing —
  observed live: a doctor reported `#general missing` when the real cause was the database being down.
- **Smell you need it.** Health passes because processes are "running"; or the probe reports a thing absent
  when its backing store is merely unreachable.
- **Worked instance (QA).** A factory doctor caught base-vs-system prompt misconfig, an empty vector index,
  and idle agents; it became runtime-aware after the agent-runtime cutover.
- **Backlog hook.** → expose the doctor as an MCP tool so agents can self-check.

## P8 — Map coverage to ground truth; don't mirror it into the vault

- **Context.** A vault that describes artifacts living elsewhere (tests, code, records).
- **The move.** The vault **points at** the real artifact and tracks the relationship
  (item → criterion → real file → status). It does **not** copy the artifact in. Ground truth stays in its
  home; the vault is the index over it.
- **Why it holds.** Mirrored copies drift silently; an index that points at the source can't go stale the
  same way. It's the same rule behind "memory points at the vault, never copies it"
  ([[rule-agent-memory-vs-vault]]).
- **Smell you need it.** Notes duplicating code/tests that also live in a repo; two copies of one fact
  drifting apart.
- **Worked instance (QA).** Tests live in the repo; the vault maps story → acceptance criterion → repo
  `.spec` → status, not note-copies of the tests.
- **Backlog hook.** → a run-artifact ingest tool that attaches results with provenance, by reference.

## Related
[[hub-synapse]] · [[note-synapse-mcp-backlog]]
