---
id: decision-0010-mcp-2026-07-28-dual-era
type: decision
title: "MCP 2026-07-28 — adopt the stateless spec as a DUAL-ERA server, never modern-only"
tags:
  - type/decision
  - area/runtime
  - status/active
related: ["[[doc-mcp-tools]]", "[[note-deepseek-harness-integration]]", "[[decision-0003-human-gated-mutation]]"]
---

**Status:** Accepted (plan) — 2026-08-22 · **Not yet implemented.** Tracked on `feat/mcp-2026-07-28`.

## Context

MCP **2026-07-28** is final and is the new standard. It replaces the bidirectional stateful protocol with
a **stateless request/response** model: no session handshake, no `Mcp-Session-Id`, method and tool names
carried in HTTP headers (`Mcp-Method`, `Mcp-Name`) so gateways route without parsing bodies, Multi
Round-Trip Requests (MRTR) in place of server-initiated requests, and `ttlMs` / `cacheScope` on list
results. Any request can land on any instance behind a round-robin load balancer.

Two findings decide the shape of our adoption.

**1. Our SDK can never speak it.** We depend on `@modelcontextprotocol/sdk@^1.30.0`, whose
`LATEST_PROTOCOL_VERSION` is `2025-11-25`. Support lives in a **repackage**, not a version bump: the
monolith split into `@modelcontextprotocol/server` + `@modelcontextprotocol/client` +
`@modelcontextprotocol/core` (v2.0.0). Conforming means swapping packages.

**2. Three of our four clients are legacy-only.** Verified against the installed binaries, not assumed:

| Client | Version | Era |
|---|---|---|
| Claude Code | 2.1.240 | **dual-era** (probes `server/discover`, falls back) |
| Cursor | 3.13.25 | legacy only (bundles SDK 1.25.1) |
| opencode | 1.18.19 | legacy only |
| DSH `dsh-mcp-client` | 0.0.1-rc.1 | legacy only (depends on SDK v1) |

The spec's compatibility matrix is explicit: **legacy client + modern server → fails**, because legacy
clients have no fall-forward mechanism. A modern-only server would break Cursor, opencode and the whole
DeepSeek Harness integration.

## Decision

Adopt 2026-07-28 as a **dual-era server**. `serveStdio(buildServer, { legacy: 'serve' })` — and `'serve'`
is the **default**: one process serves both eras from one factory with no branching in our code. Legacy
clients send `initialize` and are served exactly as today; Claude Code probes `server/discover` and gets a
modern `DiscoverResult`. Verified empirically against a v2 server built with our exact `registerTool`
call shape: both lanes answered, and a bogus version returned a proper `-32022` with the supported list.

**Never ship `legacy: 'reject'`** until Cursor, opencode and DSH have all moved.

**This ships as `1.0.0`.** Two lines, unambiguous: **`0.19.x` is the legacy line** (protocol `2025-11-25`
only) and **`1.x` is the dual-era line** (serves both). The bump is major even though no *tool* signature
changes, for three reasons: the runtime dependency is replaced wholesale rather than upgraded
(`@modelcontextprotocol/sdk` → `@modelcontextprotocol/server`), so anything reaching past our exports
breaks; the protocol a consumer's client negotiates against genuinely changes; and 1.0.0 is the honest
place to make the compatibility promise the dual-era design exists to keep — *legacy clients keep working*
— rather than leaving it implicit in a minor. A consumer pinned to `^0.19.0` stays on the legacy line
until they choose to move.

`package.json` on this branch already reads `1.0.0`, but **the release is gated on stage 2 actually
landing** — until the SDK swap is in, this branch is 1.0.0 in name only and must not be published.

## What this does and does not touch

Most of the spec does not reach us. Header routing and `Mcp-Session-Id` are **Streamable-HTTP only** — the
stdio binding carries all request metadata inline and has no header layer. MRTR replaces *server-initiated*
requests and we initiate none. We use no sampling, elicitation, roots, resources, prompts, logging or
progress notifications, and all 26 tools return text through `registerTool`, whose v2 config object is
unchanged.

The substantial change is **one file**: `mcp/server.mjs` is a module-level singleton with top-level side
effects (`assertVault()`, surface selection, registration, plugin loading, `await server.connect(...)`).
v2 wants a `buildServer()` factory. Plugin **loading** must split from plugin **registration** — `await`
the dynamic imports once at startup, then call each `register(server, ctx)` inside the factory — which
also preserves the fail-loudly contract ([[rule-synapse-fail-loudly]]): a bad plugin still throws before
we serve anything.

`lib/mcp-config.mjs` needs **no change** — the transport stays stdio, so `.mcp.json`, `.cursor/mcp.json`
and `opencode.json` stay byte-identical and `SYNAPSE_MCP_SURFACE` keeps working. The lease/fence design is
untouched: one vault per stdio process preserves the single-writer assumption.

## Consequences

- **Module-level state stays correct on stdio, and is a landmine off it.** `mcp/vault.mjs` memoizes
  `VAULT`; `mcp/tools/spawn.mjs` mints `const EPOCH = randomUUID()` per boot and memoizes DB handles;
  `mcp/tools/episodes.mjs` does the same. v2 pins one factory instance per stdio connection, and one
  connection is one process is one vault — so these are fine, and `EPOCH` per connection is arguably more
  correct than per boot. Under HTTP, `EPOCH` would be minted per request and `staleSpawns` would report
  every other request's spawns as stale. Comment it before anyone adds a handler.
- **No consumer-visible change.** Same bin, same config, same tools, same surfaces.
- Deprecated-but-working: the raw-zod-shape `inputSchema` form used at all 26 call sites. Wrapping in
  `z.object({...})` is mechanical cleanup, not conformance.

## Staged path

Each stage is independently shippable and testable.

0. **Safety net, no dependency change.** Extend `mcp/smoke.mjs` to assert the tool list per surface via a
   raw stdio JSON-RPC driver, giving an SDK-independent conformance baseline to diff against.
1. **Factory refactor, still on SDK v1.** Extract `buildServer()`; split plugin load from register; keep
   `StdioServerTransport`. Nothing changes on the wire. **Most of the work, zero protocol risk.**
2. **SDK v2 swap, dual-era.** `@modelcontextprotocol/server@2` + `serveStdio`. Test a v1 client and a v2
   client against the same binary, plus all four real clients. This is the conformant release.
3. **De-deprecate and tune.** Wrap `inputSchema` shapes in `z.object()`; set a real `ttlMs` / `cacheScope`
   on the static tool list.
4. **Deferred.** `createMcpHandler` for HTTP — only if multi-vault returns.

## Explicitly deferred: multi-vault

The original goal was one shared server for many vaults. **The spec does not define multi-tenancy** — it
suggests minting an explicit handle from a tool and passing it back as an argument. That is not an
authorization model: the moment vault selection is a tool *argument*, the only thing isolating vaults
holding finance, health and contacts data is the model's choice of argument. If this returns, the minimum
is auth-derived vault binding (the caller's identity determines the vault set, never an argument), and the
`EPOCH` / `VAULT` module state above must be reworked first.

## Open

- Ship stage 2 now or wait? Nothing is broken today — Claude Code probes, fails, falls back. The soft
  clock is its own `"no fallback in pin mode"` path: a user who pins modern breaks against us.
- Keep `@modelcontextprotocol/sdk` as a devDependency so `mcp/smoke.mjs` can test **both** eras against
  one binary.
- Do **not** read a modern version out of `LATEST_PROTOCOL_VERSION` — v2 still exports the legacy-era
  constants. The modern revision surfaces in the `server/discover` response (`supportedVersions`).
