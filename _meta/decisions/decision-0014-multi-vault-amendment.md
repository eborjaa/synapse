---
id: decision-0014-multi-vault-amendment
type: decision
title: "Multi-vault un-deferred — auth-derived binding is the mechanism, one instance is the standing limit"
tags:
  - type/decision
  - area/runtime
  - status/active
related: ["[[decision-0010-mcp-2026-07-28-dual-era]]", "[[decision-0013-ports-and-adapters]]", "[[doc-deployment-gate]]", "[[hub-synapse]]"]
---

**Status:** Accepted — 2026-08-24 · Amends [[decision-0010-mcp-2026-07-28-dual-era]] · Partially implemented.

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

Implemented: the per-vault state seam, the credential store and the bearer-token binding, the vault
registry and one-command rewire, and per-workspace roster isolation.

**Not implemented: the HTTP transport itself**, and the reason is recorded here so it is not
rediscovered. It is not an SDK gap — the handler ships in the current server package. It is that
`mcp/vault.mjs` resolves the vault **once at module load**, and dozens of references across the tool
modules read that constant. Shipping HTTP before threading the bound vault through those call sites
would accept a per-request credential, resolve it correctly, and then serve every request from
whichever vault loaded first: multi-vault in the URL, single-vault in the data. **That is worse than no
HTTP, because it looks like it works.** Thread the vault first.

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

1. Where credentials live, and whether filesystem permissions are the right boundary between a
   person's own workspaces.
2. Whether the privacy gate needs a seam it does not currently have.
3. Whether one instance is in fact enough — worth measuring before designing around it. If it is, the
   scaling question closes permanently rather than staying deferred.

## Related
[[decision-0010-mcp-2026-07-28-dual-era]] · [[decision-0013-ports-and-adapters]] · [[decision-0012-no-global-vault-pin]] · [[doc-deployment-gate]] · [[hub-synapse]]
