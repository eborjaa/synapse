---
id: doc-four-containers
type: doc
title: The four-container stack — one compose file, laptop or server
tags:
  - type/doc
  - area/runtime
  - status/active
references_docs: ["[[conventions]]", "[[doc-runtime-wiring]]", "[[doc-deployment-gate]]"]
related: ["[[hub-synapse]]", "[[decision-0016-four-container-deployment]]"]
---

# The four-container stack

`deploy/compose.yml` runs Synapse as four disposable containers over five named volumes. The same file
runs on a laptop and on a home server; **only `BIND_ADDR` differs**, and nothing in any image knows where
it is running ([[decision-0016-four-container-deployment]]).

```bash
cp deploy/.env.example deploy/.env      # BIND_ADDR=127.0.0.1 on a laptop
BIND_ADDR=127.0.0.1 ./deploy/up.sh up -d --build
```

Use `deploy/up.sh`, not raw `docker compose`: it refuses a wildcard `BIND_ADDR` **before** compose runs,
because Docker publishes the port before Node ever starts and the MCP listener's own guard would be too
late.

## The containers

| # | Container | Role | Notes |
|---|---|---|---|
| 1 | `vpn-sidecar` | terminates the tunnel | swappable — `VPN_IMAGE=tailscale/tailscale:…`; idle busybox by default |
| 2 | `dsh` | the web UI you log into | stateless; mounts `skills/` read-only; owns the network namespace |
| 3 | `synapse-core` | engine + MCP, one vault per request | **exactly one instance** |
| 4 | `ollama` | embeddings only | `profiles: [embeddings]` — the deterministic core works without it |

**`dsh` owns the network namespace.** `synapse-core` and `vpn-sidecar` join it with
`network_mode: service:dsh`, so MCP binds `127.0.0.1:3000` — the existing local-only guard, unweakened —
and dsh still reaches it. Only dsh publishes to the host, as `${BIND_ADDR}:8080:8080`. Core is never given
`BIND_ADDR`: that is a host-publish concern, and passing it in would make core listen on the public
address.

## Volumes — what makes the containers disposable

| Volume | Mounted by | Holds |
|---|---|---|
| `vaults` | core (rw) | your vaults |
| `config` | core (rw) | `vaults.json`, `tokens.json` (0600), the core lock |
| `skills` | core (rw), **dsh (ro)** | generated rosters |
| `vpn-state` | vpn-sidecar | tunnel identity |
| `ollama` | ollama | pulled models |

`SYNAPSE_SKILLS_ROOT` is what lets `skills` be a *shared* volume while `config` stays private. Without it
the roster would land under `$SYNAPSE_HOME`, and handing dsh the rosters would mean mounting the
credential store beside them. The roster plane is files only — **no MCP call is involved** in roster
delivery, which is exactly why it still works where MCP cannot go.

## Exactly one core

Two guarantees, at two layers:

- **Compose.** `container_name: synapse-core` plus `deploy.replicas: 1` make `--scale synapse-core=2`
  collide on the name.
- **Process.** `lib/core-lock.mjs` takes `$SYNAPSE_HOME/synapse-core.lock` before the listener opens.
  Compose is bypassable — two `synapse-mcp --http` against one config volume are two writers against a
  DB whose lease/fence design assumes one. A second core exits **3** with the lock's owner named.

The lock records `pid` + `host` + `startedAt`, not a bare pid, because a bare pid lies twice in
containers: a restarted core is often handed the *same* low pid it is reading out of the file (it would
find "itself" alive and crash-loop), and two containers each have a pid 7 (signalling it would let a
second core steal a lock a live one holds). A record from another host is unverifiable, so the library
**refuses** it. `deploy/core-entrypoint.sh` is the one place that may clear such a record, and only
because compose has already settled the question a layer above.

## What is not here yet

The `dsh` image is a **stub** (`deploy/dsh-stub`) that proves the roster mount and the port; the real
harness arrives with `DSH_IMAGE` in Epic 5. The VPN sidecar idles until `VPN_IMAGE` names a real tunnel.
The privacy posture is unchanged: nothing is published on a public interface
([[doc-deployment-gate]]).

## Related
[[decision-0016-four-container-deployment]] · [[doc-runtime-wiring]] · [[doc-deployment-gate]] · [[doc-repo-layout]] · [[decision-0014-multi-vault-amendment]] · [[hub-synapse]]
