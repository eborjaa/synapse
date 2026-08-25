---
id: plan-one-server-many-vaults
type: plan
title: "Plan — one MCP server, many vaults, via ports and adapters"
tags:
  - type/plan
  - area/runtime
  - status/active
references_docs: ["[[doc-mcp-tools]]", "[[doc-cli-reference]]", "[[doc-deployment-gate]]"]
related: ["[[hub-synapse]]"]
---

# Plan — one server, many vaults

The implementation plan for centralizing the MCP surface across several vaults without tying any of it
to one harness. Written before the code, so the port boundaries are argued once rather than discovered
per file.

## The problem, stated once

A vault is selected today by **which process you talk to**. Each vault installs its own engine, runs its
own `synapse-mcp`, and pins itself through generated client config. Vault identity therefore lives in
configuration, never in a request — which is what forces one process per vault, makes a new vault a new
rewire, and makes every harness see every vault's tools at once.

Two things must separate before that can change:

| Plane | Carries | Transport | Wants |
|---|---|---|---|
| Tools | the tool surface | MCP over stdio or loopback HTTP | **one** endpoint |
| Roster | the agent list | files on disk | **many** isolated directories |

They have opposite centralization pressure, which is why one "global MCP" cannot solve both. The roster
plane also *cannot* use MCP at all: [[note-dsh-extension-seams]] establishes that the DSH MCP client
implements tools only, with no `prompts/list`, so a server can never contribute an agent gesture.

## Why ports, and what already proves the shape

This is not a speculative abstraction. The roster plane **already has four adapters**, written
independently and documented in [[decision-0011-generated-harness-skills]]:

| Surface | Mechanism |
|---|---|
| Shell launcher | resolves the vault, scans `agents/agent-*.md`, defines one verb per agent |
| opencode / Cursor | renders the briefing into each client's native identity format |
| MCP registry | `synapse_list_agents` reads the same frontmatter |
| DSH skills | one generated `SKILL.md` per agent |

Four implementations of one idea, with no interface between them. The same is true on the config plane,
where the MCP config generator already branches per client. **The ports are extracted from this existing
behavior, not invented** — every adapter below has a working implementation today.

## Port signatures

Each port is an interface plus one contract test suite that every adapter must pass. The core imports
ports only; no core module may name or import a harness.

### `RosterPort`

Publishes a vault's agent roster to one harness.

- `id` — adapter name.
- `targets({ root, vaultDir, agents })` → `[{ path, content, kind }]`. Pure; writes nothing.
- `apply(targets, { write })` → `[{ path, status }]` where status is `created | updated | kept | skipped`.
- `discoveryHint({ root })` → where this harness will look, for the command's output.

Contract: pure `targets`, idempotent `apply`, and — carried from
[[decision-0011-generated-harness-skills]] — **a hand-authored file is never overwritten without an
explicit force**, and a name the harness would reject is skipped with a warning rather than renamed.

### `ToolTransportPort`

Exposes the tool surface over one transport.

- `serve(buildServer, { legacy })` — stdio today, loopback HTTP later.
- `describe()` → transport identity for diagnostics.

Contract: the same server factory produces an identical tool list on every transport. The existing
raw-JSON-RPC surface test is the baseline and must keep passing unchanged.

### `VaultBindingPort`

Resolves an inbound request to exactly one vault.

- `bind(request)` → `{ root, vaultDir, manifest }` or a typed refusal.
- `describe()` → binding mode, for diagnostics.

Contract: **binding never reads a tool argument.** Two adapters — `env-pinned` (today's behavior, one
vault per process) and `bearer-token` (many vaults, one process). A token that does not resolve is a
refusal, never a fallback to a default vault.

### `ClientConfigPort`

Writes one harness's wiring file idempotently.

- `targets({ root, vaultDir, surface, extraEnv })` → `[{ path, cfg }]`. Pure.
- `apply(targets, { write })` → changed paths.
- `readExistingSurface(root)` → the surface this vault is already wired to, or null.

Contract: idempotent, and **a re-run never downgrades a deliberately raised surface** — the read-back
rule that already exists must survive extraction, because regeneration is exactly what the upgrade path
tells people to run.

### `VaultStorePort`

All vault reads and writes behind one seam, so the storage assumptions are visible in one place.

- `read` / `list` helpers for notes, agents, hubs.
- `db(vaultDir)` → a handle **keyed by vault**, not memoized per module load.
- `epoch(vaultDir)` → the reconciliation key, likewise per vault.

Contract: two vaults exercised in one process never share a handle or an epoch. This is the port that
un-blocks HTTP.

## Adapter map

| Port | Adapters | Extracted from |
|---|---|---|
| `RosterPort` | dsh, claude-code, cursor, opencode | the roster generator + launcher rendering |
| `ToolTransportPort` | stdio, http | the server entry point |
| `VaultBindingPort` | env-pinned, bearer-token | the vault resolver |
| `ClientConfigPort` | claude, cursor, opencode | the MCP config generator |
| `VaultStorePort` | filesystem + SQLite | the MCP vault helper, spawn and episode stores |

Harness-specific facts — discovery-root ranks, server-name uniqueness, a client's provider policy,
a client's skills directory — live **only** inside their adapter. Adding a fifth harness must be one new
adapter file and zero core edits. That is the acceptance test for this refactor.

## Stages and files

Each stage is one worktree, one branch, one PR left open for review. `main` is protected and
maker ≠ checker, so nothing self-merges.

**Stage 1 — ports and contract tests.** Define the five interfaces, extract today's behavior into
adapters behind them, add one contract-test module per port run against every adapter. Strictly no
behavior change: the full suite must stay green at its current baseline, and the generated config and
roster files must be byte-identical before and after.

**Stage 2 — registry and one-command rewire.** A vault registry, a rewire-every-vault command routed
through `ClientConfigPort`, and roster generation to stable absolute paths through `RosterPort`. This is
the stage that removes the day-to-day pain and it needs no protocol work, so it ships first among the
behavior-changing stages.

**Stage 3 — per-workspace rosters.** Point each workspace at the rosters it should see using the
harness's per-profile custom-directory seam, which outranks the global user root where rosters collide
today. Independent of everything below.

**Stage 4 — per-vault state.** Key the reconciliation epoch and the memoized database handles by vault
rather than by module load. [[decision-0010-mcp-2026-07-28-dual-era]] names these explicitly as what
breaks off stdio. Highest-risk stage; it touches the lease and fence path.

**Stage 5 — HTTP transport.** A loopback HTTP adapter for `ToolTransportPort` with the bearer-token
`VaultBindingPort`. stdio keeps working unchanged, and both transports run the same contract test.
Optionally packaged as a single container instance afterwards.

## Risks

**The rank tradeoff is real and must be chosen deliberately.** Generating a roster into the vault's own
repo root wins the harness's *highest*-ranked discovery root with no configuration at all. Moving
generation to a central directory buys per-workspace isolation but gives up that zero-config property.
The plan keeps both: central generation for workspace selection, repo-root generation still available.

**Extraction can silently drop a guard.** Two rules exist today only as inline behavior — hand-authored
files are never overwritten, and a surface is never silently downgraded. Both must become explicit
contract tests in stage 1, or the refactor will quietly lose them.

**Stage 4 touches the single-writer assumption.** The lease and fence design assumes one vault per
process. Keying state per vault is necessary but not sufficient; the single-instance limit stays a
standing constraint, not a temporary one.

**The privacy gate does not inspect tool calls.** It is a path-based hook on the coding agent. A server
able to reach every vault is a new path into a sealed one, and the gate as written would not see it.
This is an open question, not a solved problem — see below.

## Open questions

1. **Where do credentials live, and what do they protect?** A mode-restricted file is the obvious
   answer, but it makes vault access a filesystem permission. That may or may not match how the
   boundary between a person's own workspaces is meant to work.
2. **Do rosters need harness-qualified names?** Per-workspace isolation means two rosters are never
   live together, so prefixing may be unnecessary — but it is cheap insurance for a workspace that
   deliberately spans two vaults.
3. **Should the privacy gate learn about the shared server?** If yes, it needs a seam it does not have
   today.
4. **Is one instance actually enough?** Worth measuring before designing around it. If it is, the
   scaling question closes permanently rather than staying deferred.

## Related
[[decision-0010-mcp-2026-07-28-dual-era]] · [[decision-0011-generated-harness-skills]] · [[note-dsh-extension-seams]] · [[doc-deployment-gate]] · [[hub-synapse]]
