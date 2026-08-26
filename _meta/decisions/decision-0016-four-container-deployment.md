---
id: decision-0016-four-container-deployment
type: decision
title: "One network namespace, one core, one bind address — the four-container stack"
tags:
  - type/decision
  - area/runtime
  - status/active
related: ["[[decision-0014-multi-vault-amendment]]", "[[decision-0015-admin-surface]]", "[[doc-four-containers]]", "[[doc-deployment-gate]]", "[[hub-synapse]]"]
---

**Status:** Accepted — 2026-08-25 · **Implemented** the same day (`feat/four-containers`).

## Context

[[decision-0014-multi-vault-amendment]] gave Synapse an HTTP transport that binds one vault per
credential, and refuses `0.0.0.0` before opening a socket. Packaging that into a stack raises three
questions the transport work deliberately left open, each with a wrong answer that looks right.

**Where does MCP listen?** The obvious move is to give core its own network and let dsh reach it by
service name — which means core binds a routable container address. That either weakens the local-only
guard or forces a second, laxer code path for "container mode". The guard is the boundary
([[doc-deployment-gate]]); a deployment must not be the reason it bends.

**What stops a second core?** `container_name` answers it for compose and for nothing else. The vault DB
is single-writer (spawn.mjs's lease/fence), and `synapse-mcp --http` is one command away.

**Where do rosters live?** The roster plane is files, read by dsh with no MCP involved. Rosters hung off
`$SYNAPSE_HOME` by construction, and `$SYNAPSE_HOME` is also where `tokens.json` lives.

## Decision

**One network namespace, owned by `dsh`.** `synapse-core` and `vpn-sidecar` join it via
`network_mode: service:dsh`. Core keeps binding `127.0.0.1:3000` — the same guard, on the same code path
— and dsh reaches it there. Only dsh publishes to the host, as `${BIND_ADDR}:8080:8080`, and core is
never given `BIND_ADDR`. Swapping the VPN is swapping one image, not editing this file.

**`BIND_ADDR` is the only laptop-vs-server switch, and it is asserted before compose starts.**
`deploy/up.sh` runs `deploy/assert-bind.mjs` — the *same* wildcard set the MCP listener refuses — and
only then invokes compose. Docker publishes the port before Node runs, so a check inside Node is too
late to matter.

**Exactly one core, at two layers.** `container_name` + `deploy.replicas: 1` for compose;
`lib/core-lock.mjs` on `$SYNAPSE_HOME/synapse-core.lock` for everything that bypasses it, acquired before
`listen()` so a refused second core cannot first steal the port. The lock records `pid` + `host` +
`startedAt`: in containers a bare pid lies in both directions — a restarted core is routinely handed the
same low pid it reads out of the file and finds "itself" alive, and two containers each have a pid 7. An
unverifiable (foreign-host) record is **refused**, never stolen; `deploy/core-entrypoint.sh` may clear
one only because compose has already guaranteed a single core container.

**`SYNAPSE_SKILLS_ROOT` splits the roster plane from the config volume**, so `skills` can be shared
read-only with dsh while `tokens.json` stays private. Unset — every host install — it resolves to the
old `$SYNAPSE_HOME/skills` and nothing moves.

## Consequences

- (+) The local-only guard is unweakened and untouched: one bind rule, one code path, asserted twice.
- (+) The stack is disposable. Every durable path is a named volume; destroy-and-recreate keeps vaults,
  registry, credentials and rosters — verified against the real stack, not just the file.
- (+) Sharing the roster plane no longer implies sharing the credential store.
- (Δ) Because dsh owns the namespace, dsh must be up for core to have a network; `depends_on` encodes it.
  Restarting dsh restarts the namespace its tenants share.
- (Δ) A foreign-host lock is a refusal, not a silent steal. Outside compose, a genuinely dead holder from
  another machine needs a human to delete the file — the safe direction for a single-writer DB.
- (−) `dsh` is a stub until Epic 5, so the stack proves the wiring, not the UI.

## Related
[[doc-four-containers]] · [[decision-0014-multi-vault-amendment]] · [[decision-0015-admin-surface]] · [[doc-deployment-gate]] · [[doc-runtime-wiring]]
