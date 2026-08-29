---
id: doc-four-containers
type: doc
title: The container stack — one compose file, laptop or server
tags:
  - type/doc
  - area/runtime
  - status/active
references_docs: ["[[conventions]]", "[[doc-runtime-wiring]]", "[[doc-deployment-gate]]", "[[doc-stack-on-a-new-machine]]"]
related: ["[[hub-synapse]]", "[[decision-0016-four-container-deployment]]", "[[decision-0021-two-container-stack]]", "[[decision-0018-dsh-session-vault-router]]", "[[plan-four-containers]]"]
---

# The container stack

> **This note keeps the id `doc-four-containers` although the stack is now two.** The id is what two
> dozen notes link to, and a decision note is a dated record rather than something to rewrite. What
> changed and why: [[decision-0021-two-container-stack]].

`deploy/compose.yml` runs Synapse as two disposable containers over four named volumes. The same file
runs on a laptop and on a home server; **only `BIND_ADDR` differs**, and nothing in any image knows where
it is running ([[decision-0016-four-container-deployment]]).

```bash
cp deploy/.env.example deploy/.env      # BIND_ADDR=127.0.0.1 on a laptop
# Optional: real DSH UI (see below). Leave DSH_IMAGE unset to keep the stub.
BIND_ADDR=127.0.0.1 ./deploy/up.sh up -d --build
```

**Running it rather than changing it?** `deploy/standalone/compose.yml` pulls published images
instead of building, so no checkout is needed at all — two `curl`s and `docker compose up`. See
[[doc-stack-on-a-new-machine]]. The file below is the build-from-source sibling.

That is the shape. **The step-by-step sequence for a machine that has never run this — both image
builds, getting vaults onto the volume, minting the credential, and a check after every step — is
[[doc-stack-on-a-new-machine]].** What follows here is the reference: what each piece is, and why.

Use `deploy/up.sh`, not raw `docker compose`: it refuses a wildcard `BIND_ADDR` **before** compose runs,
because Docker publishes the port before Node ever starts and the MCP listener's own guard would be too
late.

## The containers

| # | Container | Role | Notes |
|---|---|---|---|
| 1 | `dsh` | the web UI you log into | stub by default; set `DSH_IMAGE` for a real DeepSeek Harness. Owns the network namespace |
| 2 | `synapse-core` | engine + MCP, one vault per request | **exactly one instance** |

Two more used to be here and are not:

- **`vpn-sidecar`** was an idle busybox waiting for a `VPN_IMAGE` nobody set. Run the tunnel on the
  **host** and point `BIND_ADDR` at its interface address. The privacy guarantee was never "a VPN
  container exists" — it is that `BIND_ADDR` is not a wildcard ([[doc-deployment-gate]]).
- **`ollama`** sat behind `profiles: [embeddings]` and never started unless asked for. The capability
  is unchanged: `SYNAPSE_OLLAMA_URL` points core at any embedding host and defaults to one on the
  Docker host. Compose does not have to own that process.

**`dsh` owns the network namespace.** `synapse-core` joins it with
`network_mode: service:dsh`, so MCP binds `127.0.0.1:3000` — the existing local-only guard, unweakened —
and dsh still reaches it. Only dsh publishes to the host, as `${BIND_ADDR}:8080:8080`. Core is never given
`BIND_ADDR`: that is a host-publish concern, and passing it in would make core listen on the public
address.

## Volumes — what makes the containers disposable

| Volume | Mounted by | Holds |
|---|---|---|
| `vaults` | core (rw), **dsh (rw)** | your vaults — the UI opens a folder from here |
| `config` | core (rw) | `vaults.json`, `tokens.json` (0600), the core lock |
| `skills` | core (rw), **dsh (ro)** | generated rosters |
| `dsh-home` | dsh (rw) | DSH settings, sessions, profile patches |

**`extra_hosts` lives on `dsh` alone.** A container sharing another's network namespace cannot carry
its own host-to-IP mappings — Docker refuses with *"conflicting options: custom host-to-IP mapping and
the network mode"*. `/etc/hosts` belongs to the namespace, so core resolves `host.docker.internal`
through the entry `dsh` declares, which is how it reaches an embedding server on the host.

`SYNAPSE_SKILLS_ROOT` is what lets `skills` be a *shared* volume while `config` stays private. Without it
the roster would land under `$SYNAPSE_HOME`, and handing dsh the rosters would mean mounting the
credential store beside them. The roster plane is files only — **no MCP call is involved** in roster
delivery, which is exactly why it still works where MCP cannot go.

On every start, `synapse-core` runs that generation itself (`lib/boot-sync.mjs`: `vaults roster` plus
`skills` for each registered vault) **before** the HTTP listener opens. It also writes
`$SYNAPSE_SKILLS_ROOT/index.json` — id + root only, never tokens — so DSH can resolve the open
folder to a vault id without mounting `config/`. A missing vault is logged; it never blocks the server.

## Bootstrapping — three modes

Registering a vault and minting a credential are `docker exec` steps, and both fail quietly: the
symptom is "the session has no tools", which names neither cause. Two environment variables on
`synapse-core` give them a declarative form. **Both default to off**, so an existing stack is
unchanged ([[decision-0020-declarative-stack-bootstrap]]).

| `SYNAPSE_AUTO_REGISTER` | `SYNAPSE_BOOTSTRAP_TOKEN` | Behaviour |
|---|---|---|
| unset | unset | register and mint by hand — the long-standing path |
| `1` | unset | vault directories under `SYNAPSE_VAULTS_DIR` register themselves |
| `1` | a secret | ...and that secret grants all of them |

`lib/bootstrap.mjs` runs both **before** `boot-sync` and long before the listener, in that order
because a credential cannot grant a vault that is not registered yet. It never throws: a stack that
serves nothing because an optional convenience failed is worse than one that serves what it can.

The bootstrap secret is an ordinary credential row — hashed, granting an explicit vault set, never
admin. Four refusals keep it from being weaker than minting: a secret under 24 characters is refused;
a secret with no registered vault is refused rather than stored granting nothing; re-running is
idempotent by hash so a restart loop adds one row rather than one per boot; and auto-register never
*removes*, because a mount that has not come up yet looks exactly like a vault that is gone.

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

The privacy posture is unchanged: nothing is published on a public interface
([[doc-deployment-gate]]). Vault switching in DSH is not a generated preset — opening a folder is the
whole act ([[decision-0018-dsh-session-vault-router]]).

## A real DSH UI (`DSH_IMAGE`)

The default `dsh` image is still a stub that only proves the port. A real UI is a build of the
DeepSeek Harness. DSH **refuses** `--host 0.0.0.0` (it would expose remote code execution on the
network). Docker can only publish a port the process listens on on the container's external
interface, so the image runs DSH on `127.0.0.1:3080` and a tiny TCP proxy on `0.0.0.0:8080` *inside*
the container. The **host** publish stays `${BIND_ADDR}:8080:8080` — `127.0.0.1` on a laptop.

The image also carries `@eborja/synapse` at `/opt/synapse`. The entrypoint writes
`@eborja/synapse/dsh-plugin` with `transport: http` so tools follow the open folder and talk to
`synapse-core` — never a stdio `synapse-mcp` in the DSH container.

Build from your harness checkout (rebase onto `deepseek-ai/deepseek-harness` first):

```bash
./deploy/build-dsh.sh
# or: docker build --build-context synapse=. -t synapse-dsh:local /path/to/deepseek-harness
```

Then in `deploy/.env` (gitignored — it holds the bearer):

```
BIND_ADDR=127.0.0.1
DSH_IMAGE=synapse-dsh:local
SYNAPSE_MCP_HTTP_URL=http://127.0.0.1:3000/mcp
SYNAPSE_MCP_TOKEN=…
```

The credential must grant **every** vault you intend to open — name them all as bare arguments to
`vaults token` ([[decision-0017-path-addressed-vaults]]). `SYNAPSE_MCP_HTTP_URL` is a base, not an
endpoint: the plugin appends `/<vault-id>` for the folder the session opened, so pinning a vault id
here makes every session answer from that one vault while still looking correct.

Bring the stack up **with `--no-build`** on `dsh` (`--build` would rebuild the stub and retag it as
`DSH_IMAGE`):

```bash
BIND_ADDR=127.0.0.1 ./deploy/up.sh build synapse-core
BIND_ADDR=127.0.0.1 ./deploy/up.sh up -d --force-recreate --no-build
```

Recreate **dsh and synapse-core together**. Core joins dsh's network namespace; recreating only
dsh leaves core listening in the old namespace, so `127.0.0.1:3000` inside the new dsh never
answers.

Open two different vault folders under `/synapse/vaults/` as workspaces: each session lists its own
vault's agents, and its tools answer from that vault. Slash skills (`/synapse-<agent>`) are the roster
plane, not the plugin — `boot-sync` writes them when core starts.

Pick a model in DSH's own settings; the stack deliberately does not choose one for you.
`OPENCODE_GO_API_KEY` in `deploy/.env` is passed through if you use that provider, and an Ollama on
the Docker host resolves from the UI container as `host.docker.internal:11434`.

## Four harnesses, isolation proven

`mcp/four-harness-e2e.mjs` is Epic 6: one command, four harnesses (Claude Code · Cursor · opencode ·
DeepSeek Harness), four vault fixtures. Each harness must connect, list the orchestrator tools, reach
its bound vault, and **not** reach another — assertion four runs per harness. Offline, no API key;
assertions are on the MCP handshake and tool list, never model output. Claude / Cursor / opencode are
driven through the generated config's spawn line (those CLIs are not headless without a key, and the
result is labelled `config-spawn`). DSH is the plugin (`plugin`). Run it with
`npm run epic6` or `node --experimental-sqlite mcp/four-harness-e2e.mjs`.

## Related
[[doc-stack-on-a-new-machine]] · [[decision-0016-four-container-deployment]] · [[doc-runtime-wiring]] · [[doc-deployment-gate]] · [[doc-repo-layout]] · [[decision-0014-multi-vault-amendment]] · [[hub-synapse]]
