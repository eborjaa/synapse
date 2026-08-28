---
id: 2026-08-26-epic6-and-live-wiring
type: handover
title: "Handover — Epics 1–5 merged; Epic 6, DSH profile, and the container stack remain"
tags:
  - type/handover
  - status/active
  - area/runtime
related: ["[[hub-synapse]]", "[[decision-0017-path-addressed-vaults]]", "[[decision-0018-dsh-session-vault-router]]", "[[doc-four-containers]]", "[[doc-runtime-wiring]]"]
---

# 2026-08-26 — Epics 1–5 merged; Epic 6 and live wiring remain

Self-contained. A new session with no prior chat can continue from this. Everything through the DSH vault router is **merged into `main`**. What remains is Epic 6, two live-wiring steps, and the release.

## State of the world

| | |
|---|---|
| `main` | `486a689` — Epics 1–4 **and** PR #72 all merged |
| Registered vaults | 4: `synapse-framework`, `synapse-vault`, `arch-vault`, `univa` |
| Test suite on `main` | 471 pass / 0 fail |
| `lint --strict` | errors=0, ~54 advisory (all pre-existing split candidates) |
| stdio conformance | 3 / 11 / 20 / 26 |
| Release `2.0.0` | **NOT published.** Emmanuel decided it waits until **every** epic is done — this overrides the plan's "after Epic 1" |

### Merged pull requests

| PR | What |
|---|---|
| #68–#71 | Epics 1–4: per-request vault context, HTTP transport, admin surface, four containers |
| #72 | Per-vault web addresses **and** the DSH session→vault router |

## What was decided, and what it replaced

**Epic 5 as written in `PLAN-four-containers.md` is dead.** The plan called for a generated DSH preset per vault under `~/.dsh/.agent-presets/<vault>/`. Emmanuel rejected it: he wants switching vaults to mean opening a different folder, not picking from a dropdown. **Do not re-propose presets.** Update the plan file rather than building past it.

Two decision notes carry the reasoning:

- [[decision-0017-path-addressed-vaults]] — one credential may grant several vaults; the URL path picks which one answers and can only narrow the grant. A leaked credential now exposes everything it grants; that trade was accepted deliberately.
- [[decision-0018-dsh-session-vault-router]] — DSH sessions bind their vault from `session.header.cwd` through a Synapse-owned plugin.

### Ruled out on evidence — do not revisit without new facts

1. **MCP `roots`.** The SDK states the 2026-07-28 revision *"has no server→client request channel, so the call fails before any wire traffic"*; the legacy path we serve is stateless, where *"gates refuse"*; `listRoots` is deprecated there. Independently, DSH's MCP client constructs with `{ capabilities: {} }` and the string `roots` appears nowhere in `packages/mcp/mcp-client/`.
2. **`dsh-mcp-manager`** (community npm plugin, reported to add per-workspace MCP config). Its own source persists servers in `$DSH_HOME/mcp-servers.json` *"(global, shared by …)"*; its `cwd` is the spawned child's working directory and its `scopes` are OAuth scopes. It does not do this.
3. **Vault identity as a tool argument.** Still refused, permanently.

### The structural fact that explains all of it

DSH resolves **skills** per session (`skill-filesystem` → `roots(options.cwd)` → `<projectRoot>/.dsh/skills`, rank 100) but registers **MCP tools** once per process (`ctx.tools.register` at activation, no cwd). Claude Code, Cursor and opencode have no such problem because Synapse writes their config *inside the vault* (`lib/ports/client-config.mjs` — `join(root, ".mcp.json")`, `.cursor/mcp.json`, `opencode.json`). **DSH is the only client with no per-folder config layer.**

## Live wiring on this machine — read before testing

All three consumer vaults are **dev-linked** to the framework repo so they run merged `main` rather than their installed engines (`synapse-vault` was 1.1.1, `arch-vault` 0.18.2):

```
<vault>/node_modules/@eborja/synapse  ->  /Users/eborja/synapse/synapse-framework
```

The original package directory is preserved beside each link as `node_modules/@eborja/synapse.prelink-backup`. To undo one: delete the symlink, rename the backup back.

Verified by running the exact command Cursor is configured with:

| Vault | Tools |
|---|---|
| `synapse-vault` | **27** |
| `arch-vault` | 26 |
| `univa` | 26 |

The 27 is not a bug — `synapse-vault` carries one plugin in `_meta/mcp-plugins/`, so it publishes one extra tool. **This is exactly why the DSH router registers tools per session rather than once at startup.** Two vaults do not publish the same list.

## What's next (in order)

### 1. Point DSH at the new plugin — NOT yet done

`~/.dsh/profiles/web/cordis.patch.yml` still holds the original hard-pinned row: `serverName: synapse`, stdio, with `args`, `cwd`, and `env.SYNAPSE_VAULT` all pointing at `synapse-vault`. Replace it:

```yaml
- id: mcp-synapse
  name: '@eborja/synapse/dsh-plugin'
  config:
    surface: orchestrator
```

Then confirm: open two different vault folders as DSH workspaces and check each session sees **its own** agent list *and* its own tools. `synapse-vault` should show the extra plugin tool; the others should not.

Note `hooks-synapse` in the same file also pins `projectDir` to `synapse-vault`. Decide whether that follows the workspace too — it was not part of this work.

### 2. Bring the container stack up

Images are built (`synapse-synapse-core`, `synapse-dsh-stub`, `synapse-vpn-idle`) but **containers and volumes were destroyed** after Epic 4 verification — the volumes only held a throwaway demo vault and a test credential.

```bash
cd /Users/eborja/synapse/synapse-framework
cp deploy/.env.example deploy/.env      # BIND_ADDR=127.0.0.1
BIND_ADDR=127.0.0.1 ./deploy/up.sh up -d --build
```

Use `deploy/up.sh`, never raw `docker compose` — it refuses a wildcard `BIND_ADDR` *before* Docker publishes the port. Register real vaults on the `vaults` volume rather than a demo, and mint credentials with the new multi-vault form if wanted:

```bash
synapse vaults token work personal --label "laptop"    # prints one address per vault
```

### 3. Epic 6 — the last piece, run ONCE

One `synapse-core`, four harness containers (Claude Code · Cursor CLI · opencode · DSH), four vault fixtures. Each harness proves four things: it connects · its tool list matches · it reaches its bound vault · **it cannot reach another**. Assertion 4 must run **per harness** — a leak can hide in one client's wiring and not another's. Offline: assert on the MCP handshake and tool list, never model output, and require no API key. If a CLI cannot be driven headlessly, fall back and **label that harness's result weaker**.

### 4. Release 2.0.0

Only after Epic 6. Follow [[doc-npm-release]] exactly; publishing is a human step. Until then the CLI is `node lib/vaults.mjs …`, not `synapse vaults …`.

## Gotchas that cost time

- **The shell's working directory resets to the main tree between commands.** Always use absolute paths into a worktree; a relative write lands in `synapse-framework` instead.
- **macOS has no `timeout`.** A probe using it reports a false failure; use a Node-side timer.
- **`--label "two words"` used to be read as a vault id.** Fixed and pinned by a subprocess test, but the same shape exists in other subcommands — bare arguments must skip a value-taking flag's value.
- **Canonicalize every level when walking up for a vault**, not just the starting path: `realpath` fails on a directory that does not exist, and the walk then matches nothing while looking correct.

## Open escalations

None. Nothing is half-done; `main` is green.

## Related
[[hub-synapse]] · [[decision-0017-path-addressed-vaults]] · [[decision-0018-dsh-session-vault-router]] · [[doc-four-containers]] · [[doc-runtime-wiring]]
