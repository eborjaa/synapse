---
id: decision-0015-admin-surface
type: decision
title: "Admin tools are a credential-authorized catalogue, never a process flag"
tags:
  - type/decision
  - area/runtime
  - status/active
related: ["[[decision-0010-mcp-2026-07-28-dual-era]]", "[[decision-0014-multi-vault-amendment]]", "[[doc-mcp-tools]]", "[[hub-synapse]]"]
---

**Status:** Accepted — 2026-08-25 · **Implemented** the same day (`feat/admin-surface`).

## Context

Vault registration and credential mint/revoke are machine-scoped. They do not belong in an everyday
session: a prompt injection in a note that can *see* `synapse_admin_mint` has a tool to call, even if
the handler would later say no. [[decision-0010-mcp-2026-07-28-dual-era]] already refused vault identity
as a tool argument; the same class of failure applies to *privilege* as a process flag.

`--surface admin` looks like the existing permission dial (`skeleton ⊂ standard ⊂ full ⊂ orchestrator`).
It is the wrong seam. A shared HTTP server started with that flag would give every connected credential
the privileged catalogue. Stdio has no bearer at all, so the same flag would privilege whoever launched
the process.

## Decision

**Admin is a scope on the bearer credential.** `synapse vaults token <id> --admin` (or
`synapse_admin_mint` with `admin:true`, itself only reachable from an already-admin session) stores
`scopes: ["admin"]` on the hashed token row. The HTTP factory reads that field after bind and, only then,
calls `buildServer({ surface: "admin", adminAuthorized: true })`.

The ladder is `skeleton ⊂ standard ⊂ full ⊂ orchestrator ⊂ admin`. Everyday surfaces — including a
normal token against a process started with `--surface admin` — never register the five admin tools.
Absence is the boundary, not a handler that refuses.

Generated client config (`MCP_SURFACES` in `lib/mcp-config.mjs`) still lists only the four everyday
surfaces. Writing `admin` into `.mcp.json` would start a stdio server with no bearer; that process
refuses to start.

## Consequences

- (+) A note in a normal session cannot mint itself another vault, because mint is not on the catalogue.
- (+) The first admin credential is bootstrapped from the CLI, which is already human-gated.
- (−) Catalogue identity is no longer solely `--surface` on HTTP: an admin-scoped bearer upgrades.
  Plugins remain the shared `SYNAPSE_MCP_PLUGINS` set.

## Related
[[decision-0010-mcp-2026-07-28-dual-era]] · [[decision-0014-multi-vault-amendment]] · [[doc-mcp-tools]] · [[hub-synapse]]
