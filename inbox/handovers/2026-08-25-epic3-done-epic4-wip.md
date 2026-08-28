---
id: 2026-08-25-epic3-done-epic4-wip
type: handover
title: "Handover — Epic 3 done (PR #70), Epic 4 WIP uncommitted"
tags:
  - type/handover
  - status/active
  - area/runtime
related: ["[[hub-synapse]]", "[[decision-0014-multi-vault-amendment]]", "[[decision-0015-admin-surface]]", "[[doc-mcp-tools]]", "[[doc-runtime-wiring]]"]
---

# 2026-08-25 — Epic 3 done (PR #70), Epic 4 WIP uncommitted

Self-contained. A new session with no prior chat can continue from this. Stopped mid-Epic-4 at Emmanuel's request. Epic 3 is committed and PR'd; Epic 4 files are on disk in the containers worktree and **not committed**.

## What was done

| | |
|---|---|
| `main` | `c4a29f0` — **unchanged**. Nothing from this plan is merged |
| Plan | `PLAN-four-containers.md` (main tree root) — **untracked**, do not commit unless asked |
| Epic 1 | **DONE, PR OPEN** https://github.com/eborjaa/synapse/pull/68 |
| Epic 2 | **DONE, PR OPEN**, stacked on #68 https://github.com/eborjaa/synapse/pull/69 |
| Epic 3 | **DONE, PR OPEN**, stacked on #69 https://github.com/eborjaa/synapse/pull/70 |
| Epic 4 | **STARTED, NOT COMMITTED** |
| Epics 5–6 | not started |
| Release `2.0.0` | **after Epic 1**. Until then: `node lib/vaults.mjs …`, not `synapse vaults …` |

### Stacked PRs — retarget after the base merges; never merge first

| PR | Head | Base | Commit |
|---|---|---|---|
| #68 | `feat/thread-vault-context` | `main` | `3ebd37a` |
| #69 | `feat/http-transport` | `feat/thread-vault-context` | `bf2c711` |
| #70 | `feat/admin-surface` | `feat/http-transport` | `ecf1aa6` |

### Worktrees (`node_modules` → main tree, untracked, never commit)

| Epic | Path | Branch |
|---|---|---|
| 1 | `/Users/eborja/synapse/.worktrees/thread` | `feat/thread-vault-context` |
| 2 | `/Users/eborja/synapse/.worktrees/http` | `feat/http-transport` |
| 3 | `/Users/eborja/synapse/.worktrees/admin` | `feat/admin-surface` @ `ecf1aa6` |
| 4 | `/Users/eborja/synapse/.worktrees/containers` | `feat/four-containers` from `origin/feat/admin-surface` |
| main | `/Users/eborja/synapse/synapse-framework` | `main` |

### Settled plan answers — do not re-ask

1. Epic 6 runs **once at the end**, not per epic.
2. Release **2.0.0 after Epic 1**, not before.
3. Vault is picked **before session start** (US-5.1 as written).
4. Bind loopback or VPN interface — **never `0.0.0.0`**. Exactly one `synapse-core`. Vault identity is never a tool argument.
5. Admin authorization comes from the **credential**, not `--surface admin`.

### Epic 3 (this session) — the idea

Admin tools are **absent** from everyday catalogues (not a handler that says no). An admin-scoped bearer upgrades that **request** to surface `admin` (31 tools = orchestrator + 5). A normal bearer never lists them, even if the process was started with `--surface admin` (downgraded to orchestrator).

`MCP_SURFACES` still has only four everyday surfaces. Stdio **throws at startup** if `SYNAPSE_MCP_SURFACE=admin`. First admin credential: `node lib/vaults.mjs token <id> --admin`.

Tools that must stay off everyday `tools/list`: `synapse_admin_list` · `_register` · `_mint` · `_revoke` · `_sync`.

HTTP factory (do not relitigate):

```js
const adminAuthorized = isAdminAuthorized(bound); // scopes includes "admin"
return buildServer({
  surface: surfaceForRequest(surface, adminAuthorized),
  plugins, vault, adminAuthorized,
});
```

Load-bearing files: `mcp/tools/admin.mjs`, `mcp/build-server.mjs` (`surfaceForRequest`, `EVERYDAY_SURFACES`), HTTP factory in `lib/ports/index.mjs`, `lib/ports/vault-tokens.mjs` (`TOKEN_SCOPES`), `mcp/server.mjs` (stdio refuse), `_meta/decisions/decision-0015-admin-surface.md`, `mcp/admin-surface.test.mjs`.

Gates: **406 pass / 0 fail** (baseline 396). Lint `--strict` errors=0 (50 advisories). Stdio wire **byte-identical to Epic 2**: 3 / 11 / 20 / 26. HTTP: normal token 26 tools zero admin; admin token 31; mutations in transcript.

`synapse_log` already recorded Epic 3 done (episode refs PR #70 / `ecf1aa6` / `decision-0015`).

Also on **main working tree** (do not commit unless asked): this handover file, and `agents/agent-curator.md` `related:` now includes `[[2026-08-25-epic3-done-epic4-wip]]` (from `synapse_create_handover` used_by).

## What's next (do in order)

Finish **Epic 4** in `/Users/eborja/synapse/.worktrees/containers` on `feat/four-containers`. Stack the PR on **#70** (`--base feat/admin-surface`). Never merge.

### Design already chosen in the WIP (do not relitigate without a reason)

- `dsh` owns the network namespace. `synapse-core` and `vpn-sidecar` use `network_mode: service:dsh` so MCP binds **`127.0.0.1:3000`** while dsh reaches it there.
- Host publish is `ports: ["${BIND_ADDR}:8080:8080"]` on **dsh only**. Core compose sets `SYNAPSE_MCP_HOST=127.0.0.1` — do **not** pass `BIND_ADDR` into core as the MCP listen address.
- `container_name: synapse-core` + `deploy.replicas: 1` so `--scale synapse-core=2` collides.
- Process lock: `lib/core-lock.mjs` on `$SYNAPSE_HOME/synapse-core.lock` — **written + unit-tested, NOT wired into `startHttpServer` yet**.
- DSH real image is Epic 5. Compose uses stub `deploy/dsh-stub` (`skills` `:ro`, `:8080`). Override with `DSH_IMAGE`.
- VPN sidecar defaults to idle busybox (`deploy/vpn-idle`). Swap with `VPN_IMAGE=tailscale/tailscale:…`.
- Ollama is `profiles: [embeddings]`.
- Planned: `SYNAPSE_SKILLS_ROOT` so the `skills` volume is not buried under `SYNAPSE_HOME` — **`rosterDir` in `lib/vaults.mjs` not yet changed**.

### On disk, uncommitted (skip `node_modules`)

```
.dockerignore
lib/core-lock.mjs
lib/core-lock.test.mjs
deploy/compose.yml
deploy/Dockerfile
deploy/core-entrypoint.sh
deploy/assert-bind.mjs
deploy/up.sh
deploy/.env.example
deploy/dsh-stub/Dockerfile
deploy/dsh-stub/server.mjs
deploy/vpn-idle/Dockerfile
```

Docker is available (`Docker Compose version 5.3.1`). `deploy/up.sh` must run `assert-bind.mjs` before compose so `BIND_ADDR=0.0.0.0` cannot publish the UI.

### Checklist to close Epic 4

1. Wire `acquireCoreLock()` into `mcp/http-server.mjs` `startHttpServer` (acquire before listen; `close()` releases; release on throw). Direct `http.serve()` in unit tests stays unlocked.
2. `rosterDir` honors `SYNAPSE_SKILLS_ROOT` (default `$SYNAPSE_HOME/skills`); vaults test; restore env in sandbox.
3. Compose contract tests + add `deploy/*.test.mjs` to `package.json` `test` if tests live there. Four services, one `container_name: synapse-core`, no `0.0.0.0`, dsh skills `:ro`, named volumes, ollama profile, assert-bind rejects wildcards. Optional: `docker compose --env-file deploy/.env.example -f deploy/compose.yml config`.
4. Docs in the same PR: CHANGELOG, doc-runtime-wiring, README, doc-repo-layout, a short four-container doc, decision-0016 (or amend 0014). `package.json` `files` includes `deploy/`.
5. `chmod +x deploy/up.sh deploy/core-entrypoint.sh`.
6. Gates: suite must not drop below **406**; lint `--strict` errors=0; stdio 3/11/20/26 byte-identical to Epic 3.
7. Commit explicit paths; push; `gh pr create --base feat/admin-surface --head feat/four-containers`; do not merge.

Then Epic 5 (DSH presets / vault picker), then Epic 6 (four-harness e2e, once).

### Compose gotcha

Host `BIND_ADDR:8080` → container :8080. The dsh stub listens `0.0.0.0:8080` *inside* the container so docker-proxy can reach it. That is not a host wildcard. MCP core still binds `127.0.0.1` in the shared netns.

`core-lock` `pidAlive`: `kill(pid,0)` ok → alive; `ESRCH` → dead (steal); `EPERM` → alive.

### Epic 5–6 reminders

Epic 5: `~/.dsh/.agent-presets/<vault>/`. Fold `~/synapse/dsh-synapse`. Re-read `notes/note-dsh-extension-seams.md` at start (web disables host skill-filesystem).

Epic 6: once at the end; offline handshake + tool list; if a CLI cannot be driven headlessly, fall back and **label it weaker**.

## Open escalations

None. PRs #68–#70 stay open for human review. Do not merge.

## Relaunch command

In a new Cursor/Opus session, from `/Users/eborja/synapse/synapse-framework`:

1. `synapse_resume_from_handover` with ref `2026-08-25-epic3-done-epic4-wip`
2. `synapse_history` query `Epic 4 four containers`
3. `synapse_recall` task `Epic 4 four containers compose lock docs PR`
4. Continue in `/Users/eborja/synapse/.worktrees/containers`

Paste prompt is in the chat that wrote this note.

## Related

[[hub-synapse]] · [[decision-0014-multi-vault-amendment]] · [[decision-0015-admin-surface]] · [[doc-mcp-tools]] · [[doc-runtime-wiring]] · [[rule-context-handover]]
