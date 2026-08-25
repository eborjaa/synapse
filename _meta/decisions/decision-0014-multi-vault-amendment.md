---
id: decision-0014-multi-vault-amendment
type: decision
title: "Multi-vault un-deferred — auth-derived binding is the mechanism, one instance is the standing limit"
tags:
  - type/decision
  - area/runtime
  - status/active
related: ["[[decision-0010-mcp-2026-07-28-dual-era]]", "[[decision-0013-ports-and-adapters]]", "[[doc-deployment-gate]]", "[[hub-synapse]]", "[[decision-0015-admin-surface]]"]
---

**Status:** Accepted — 2026-08-24 · Amends [[decision-0010-mcp-2026-07-28-dual-era]] · **Implemented 2026-08-25.**

## Context

[[decision-0010-mcp-2026-07-28-dual-era]] deferred multi-vault, and set two conditions for un-deferring
it: *"the minimum is auth-derived vault binding (the caller's identity determines the vault set, never
an argument), and the `EPOCH` / `VAULT` module state above must be reworked first."*

Both conditions are now met, so this amends that deferral rather than reversing it — the reasoning
still stands; what changed is that the prerequisites exist.

The motivating pressure was operational: one engine per vault means one process per vault, one upgrade
per vault, and a harness that mounts a client per vault sees every vault's tools at once. The harness
also **structurally cannot** carry agents over MCP ([[note-dsh-extension-seams]]: the MCP client
implements tools only, no `prompts/list`), so centralizing the server never was a complete answer.

## Decision

**Multi-vault is un-deferred, along two planes that never touch.**

- **Tools travel over the wire.** One server, with the vault bound **per request by credential**.
- **Rosters travel on disk.** One generated roster per vault, selected **per workspace by path**.

They have opposite centralization pressure — one endpoint, many directories — which is why one "global
MCP" could never have solved both.

**The mechanism is auth-derived binding.** A credential maps to exactly one vault. Binding reads the
credential and nothing else; there is no code path by which a tool argument influences which vault
answers, and a contract test passes vault ids through every model-authorable field alongside a valid
credential to prove it. An unknown or missing credential is a **refusal**, never a fallback to a default
vault — a fallback would mean a typo silently reads a different vault, which is the same failure class
as the global vault pin that [[decision-0012-no-global-vault-pin]] removed.

**One instance is a standing limit, not a temporary one.** The protocol is genuinely ready for
replicas — [[decision-0010-mcp-2026-07-28-dual-era]] records that any request may land on any instance
— but protocol statelessness and storage statelessness are different claims. The vault is SQLite, the
tools write leases and episodes to it, and the lease/fence design assumes one writer per vault DB.
Keying state per vault makes **many vaults in one process** safe; it does not make **many processes on
one vault** safe, and nothing in this decision should be read as suggesting otherwise. Horizontal
scaling would require moving episodic memory and the spawn registry off SQLite — a separate project,
undertaken for concurrency that does not currently exist.

**Local only.** [[doc-deployment-gate]] opens by calling this "a core intention, not a feature." A
loopback HTTP transport honors it; a hosted endpoint does not. Containerization is a packaging choice
and is neutral here — where it runs is the question, and the answer is the owner's own hardware.

## What is implemented, and what is not

Implemented: the per-vault state seam, the credential store and bearer-token binding, the vault registry
and one-command rewire, per-workspace roster isolation, the per-request vault context, **and the
authenticated HTTP `ToolTransportPort` adapter**.

**The threading precondition this section used to record as outstanding is now met.** It read: shipping
HTTP before threading the bound vault through the tool call sites would accept a per-request credential,
resolve it correctly, and then serve every request from whichever vault loaded first — multi-vault in
the URL, single-vault in the data, *worse than no HTTP because it looks like it works*. That reasoning
was right and is why the order was what it was; it is simply no longer a blocker.

The module-load `VAULT` constant is gone from every call site. A bound vault is now a **value** —
`mcp/vault-context.mjs` — passed to `buildServer({ vault })` and closed over by each tool handler. The
seam sits there rather than deeper because of what the SDK guarantees: `McpServerFactory` is invoked
**once per HTTP request** under `createMcpHandler` (with `authInfo`) and once per connection under
`serveStdio`, so "one server per bound vault" and "one server per serving unit" are the same object and
no ambient per-request state is needed. Two vaults in one process therefore share no handle, no epoch
and no cached briefing — not by convention, but because they share no name to read.

`mcp/vault.mjs` still exports `VAULT` and friends, deprecated, because `<vault>/_meta/mcp-plugins/*.mjs`
is a documented extension point with consumers this package does not ship. Nothing inside the package
imports them, and a test asserts that — the old bug is re-introducible by one careless import, and would
be invisible again until something served two vaults.

`synapse-mcp --http` now runs that adapter. It authenticates before MCP dispatch, passes the credential
through the SDK's `authInfo`, binds it to one live registry entry, and hands that context to the same
`buildServer()` factory stdio uses. Missing, unknown, revoked, and gone-vault credentials attach no vault.
The response for an unknown token and a known token whose vault path is gone is byte-identical — status,
body, and bearer challenge — because any distinction is an enumeration oracle.

The listener defaults to `127.0.0.1` and rejects wildcard addresses (`0.0.0.0`, `::`) before opening a
socket. An explicit non-loopback bind exists only for the owner's VPN-interface address; it does not
make hosted deployment an accepted shape.

**Not implemented here:** the four-container package, TLS/VPN termination, DSH presets, or replicas.
Those are later epics. Exactly one `synapse-core` remains the standing limit because keying handles by
vault did not turn SQLite into multi-writer storage.

## Consequences

- (+) A new vault is one registration and one credential, not a new server and a new rewire.
- (+) A workspace sees exactly the agents of the vaults it names, because rosters no longer share one
  namespace.
- (−) Per-vault configuration does not disappear — it becomes one credential instead of one server.
  Centralizing the process is not the same as centralizing the configuration, and this decision claims
  only the former.
- (−) The privacy gate is a path-based hook and does not inspect tool calls. A server able to reach
  every vault is a new path into a sealed one. This is **open**, not solved.

## Open

1. Whether the privacy gate needs a seam it does not currently have.
2. Whether one instance is in fact enough — worth measuring before designing around it. If it is, the
   scaling question closes permanently rather than staying deferred.

## Related
[[decision-0010-mcp-2026-07-28-dual-era]] · [[decision-0013-ports-and-adapters]] · [[decision-0012-no-global-vault-pin]] · [[decision-0015-admin-surface]] · [[doc-deployment-gate]] · [[hub-synapse]]
