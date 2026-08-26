---
id: plan-four-containers
type: plan
title: "Plan — Synapse in four containers"
tags:
  - type/plan
  - area/runtime
  - status/active
references_docs: ["[[doc-four-containers]]", "[[doc-runtime-wiring]]"]
related: ["[[hub-synapse]]", "[[decision-0016-four-container-deployment]]", "[[decision-0018-dsh-session-vault-router]]"]
---

# PLAN — Synapse in Four Containers

> Epics 1–4 and the DSH vault router are on `main`. Epic 5 as written (generated presets) was
> rejected. Epic 6 is `mcp/four-harness-e2e.mjs`. Release 2.0.0 waits until after Epic 6.

---

## 0. Where to run

```bash
cd /Users/eborja/synapse/synapse-framework
```

That is the `@eborja/synapse` repo and the source of truth. It is also itself a Synapse vault, so its own
MCP tools are available to you.

**Current state, verified:**

| | |
|---|---|
| `main` | `c4a29f0` — 9 PRs merged (#57–#66) |
| Tests | 374 passing, 0 failing |
| Lint | `node lib/lint.mjs --strict` → errors=0 |
| Package version | `1.1.1` (npm also 1.1.1 — **2.0.0 not released**) |
| Ports | 5 declared in `lib/ports/` |
| Vaults registered | 4 — framework, synapse-vault, arch-vault, univa |
| Setup | complete: vaults wired, rosters generated, shell rc clean |

**Until `2.0.0` ships, `synapse` on `PATH` is the old published package.** Run new commands as
`node lib/vaults.mjs …`, not `synapse vaults …`.

---

## 1. THE DELIVERABLE

**Four containers on one Linux machine — your laptop or a home server — reachable from any device on
your VPN.**

```
   your devices                ONE LINUX MACHINE (laptop OR home server — same files)
   ┌──────────┐   ┌─────┐    ┌──────────────────────────────────────────────────────┐
   │ phone    │──▶│     │    │  ① vpn-sidecar ──https──▶ ② dsh                       │
   │ laptop   │──▶│ VPN │───▶│     terminates tunnel      the web UI you log into    │
   │ any auth │──▶│     │    │     NO PUBLIC PORT              │ MCP                 │
   └──────────┘   └─────┘    │                                 ▼                     │
                             │                      ③ synapse-core ──▶ ④ ollama      │
                             │                      binds a vault per request        │
                             │                      EXACTLY ONE INSTANCE             │
                             ├──────────────────────────────────────────────────────┤
                             │  VOLUMES — all state lives here, never in an image    │
                             │  vaults/          config/            skills/          │
                             │  4 git repos      vaults.json        one dir per vault│
                             │                   tokens.json (0600) read-only → dsh  │
                             └──────────────────────────────────────────────────────┘
```

**Everything above the volumes is disposable. Delete every container and you have lost nothing.**

**Nothing is ever published to the public internet.** The only listening socket reachable off-host is the
VPN's. Bind to the VPN interface or to localhost — never `0.0.0.0`.

### Why threading and HTTP are in scope

② `dsh` and ③ `synapse-core` are **separate containers**. stdio is pipes between a parent and a child
process — it needs a shared process tree, which two containers do not have. **So a four-container design
requires a network transport between them, and that requires the vault to travel in the request.**

Threading and HTTP are not a detour. They are what the four-container design costs.

---

## 2. The system these containers run

The containers are a deployment of an architecture that already exists. Nine layers, of which the bottom
six are built and merged:

| Layer | | State |
|---|---|---|
| ① | your devices | design |
| ② | the VPN — swappable | design |
| ③ | the harness (dsh) — one adapter among four | design |
| ④ | **two planes: tools over the wire · rosters on disk** | **built** |
| ⑤ | vault binding + surfaces | **built** |
| ⑥ | the ports layer — where harness knowledge stops | **built** |
| ⑦ | the engine — render · augment · recall · lint · spawn | **built, unchanged** |
| ⑧ | the substrate — Markdown + manifest + SQLite | **built, unchanged** |
| ⑨ | **the gap — HTTP transport + vault threading** | **not built** |

**The two planes matter for the container wiring.** Tools go `dsh → core` over the network as MCP.
Rosters go `core → dsh` as **files through a shared volume**, because an MCP server structurally cannot
carry an agent definition — the DSH MCP client is tools-only, with no `prompts/list`.

That is why `skills/` is a volume mounted read-only into `dsh`, and not an API call.

---

## 3. Non-negotiable constraints

These killed designs that were otherwise tempting. Do not relitigate them mid-build.

1. **Local only.** Loopback or a VPN interface, never `0.0.0.0`, never a hosted endpoint.
   `doc-deployment-gate`: "a core intention, not a feature."
2. **One writer per vault database.** The lease/fence design in `mcp/tools/spawn.mjs` assumes it.
   **Exactly one `synapse-core` instance** — no replicas, no horizontal scaling.
3. **Vault identity is never a tool argument.** It comes from the caller's credential or it does not
   exist (`decision-0010`).
4. **Agents propose, humans merge.** No self-merging, no direct database writes.

---

## 4. Build order

Each epic gates the next.

```
[done] engine + ports + setup
   ↓
 E1  thread the vault          ← the gate; separate containers are impossible without it
   ↓
 E2  HTTP transport            ← what lets ② and ③ be different boxes
   ↓
 E3  admin surface
   ↓
 E4  THE FOUR CONTAINERS       ← the deliverable
   ↓
 E5  presets — vault picker
   ↓
 E6  end-to-end across four harnesses
```

---

## 5. User stories

Every acceptance criterion becomes an executable test. None is a judgement call.

### Epic 1 — A request carries its own vault

*Prerequisite. Without it, `synapse-core` cannot be its own container.*

**US-1.1** — As the vault owner, I want one running Synapse to answer for whichever vault the request is
for, so that four vaults stop needing four processes.
- Given one process with two vaults available
- When a request for vault A and one for vault B arrive
- Then each answers from its own vault, with no leakage in either direction

**US-1.2** — As someone using Synapse today, I want nothing to change while this lands.
- Given the existing stdio setup
- When the threading change is applied
- Then the full suite passes unchanged and generated config is byte-identical

**US-1.3** — As someone whose vaults hold finances, I want two vaults in one process to share nothing.
- Given two vaults touched in one process
- Then they never share a database handle, an epoch, or a cached briefing

**Scope:** 71 references across 8 modules under `mcp/`. Replace the module-load vault constant with a
per-request context. stdio keeps working — the context is simply constant there.
**Gate:** full suite green · generated config byte-identical · a two-vault test in one process.

### Epic 2 — One server, reachable over the network

*What makes ② and ③ separate containers possible.*

**US-2.1** — As the vault owner, I want one long-lived Synapse that many clients connect to.
- Given the server listening on loopback
- When two clients connect at once
- Then both are served, and the tool list is identical to stdio's

**US-2.2** — As the vault owner, I want my credential to decide which vault answers.
- Given a credential bound to vault A
- When a request arrives carrying vault B's id in its arguments
- Then vault A answers, and the argument is read by nothing

**US-2.3** — As a careful owner, I want a bad credential refused outright.
- Given an unknown, revoked, or missing credential
- Then the request is refused with no vault attached
- And the message is identical for "unknown" and "vault gone"

**US-2.4** — As someone mid-migration, I want stdio to keep working alongside HTTP.
- Then both transports serve the same tool list from the same factory

**Scope:** `createMcpHandler` (ships in `@modelcontextprotocol/server@2` — verified present) as a second
`ToolTransportPort` adapter. The bearer binding in `lib/ports/vault-tokens.mjs` moves from built-and-tested
into the request path.
**Gate:** one contract test passes on both transports · two vaults answered correctly from one process.

### Epic 3 — Privileged operations are separate

**US-3.1** — As the vault owner, I want an everyday session to have no ability to mint credentials, so
that a prompt injection in a note cannot grant itself another vault.
- Given a session on a normal surface
- Then no credential or vault-registration tool appears in its catalogue at all
- And this is absence, not refusal — there is nothing to call

**US-3.2** — As the vault owner, I want to manage vaults and credentials from inside the harness.
- Given a session started with an admin credential
- Then register, list, mint, revoke and sync are available
- And every mutation is reported in the transcript

**Scope:** one new tier on the existing ladder — `skeleton ⊂ standard ⊂ full ⊂ orchestrator ⊂ admin`.
**Gate:** a normal session's tool list provably excludes every credential tool.

### Epic 4 — THE FOUR CONTAINERS

*The deliverable.*

**US-4.1** — As the owner of a laptop and a home server, I want the same compose file to run in both, so
that moving is copying volumes.
- Then only the bind address differs (`BIND_ADDR=127.0.0.1` vs the VPN interface)
- And nothing in any image knows where it is running

**US-4.2** — As someone who will rebuild often, I want every container to be disposable.
- Given a running stack
- When every container is destroyed and recreated
- Then vaults, registry, credentials and rosters are all intact

**US-4.3** — As someone who works from a phone, I want to reach it from any device on my VPN.
- Then the UI is reachable over the VPN interface
- And **nothing is published on a public interface — asserted, not assumed**
- And swapping the VPN means swapping one container

**US-4.4** — As the vault owner, I want exactly one `synapse-core`, so that the single-writer guarantee
survives containerisation.
- Then the compose file cannot scale it
- And starting a second instance against the same volumes is refused or documented as unsupported

**US-4.5** — As the vault owner, I want rosters to reach `dsh` as files, so that the roster plane keeps
working where MCP cannot go.
- Given `synapse-core` writes `skills/`
- Then `dsh` mounts it read-only and discovers the agents
- And no MCP call is involved in roster delivery

**US-4.6** — As the vault owner, I want semantic search to keep working, so that `augment` and
`embeddings` still function in the stack.
- Then `ollama` is reachable from `synapse-core`
- And the deterministic core still works with `ollama` stopped

**Containers:**

| # | Container | Role | Notes |
|---|---|---|---|
| 1 | `vpn-sidecar` | terminates the tunnel, TLS for the browser | swappable — tailscale, wireguard, anything |
| 2 | `dsh` | the web UI you log into | stateless; mounts `skills/` read-only |
| 3 | `synapse-core` | engine + MCP, binds a vault per request | **exactly one instance** |
| 4 | `ollama` | embeddings only | optional — deterministic core works without it |

**Volumes:** `vaults/` (rw) · `config/` — `vaults.json`, `tokens.json` 0600 (rw) · `skills/` (rw for
core, ro for dsh).

**Gate:** the stack comes up from one compose file on a laptop and on a server, with only the bind
address differing · destroy-and-recreate loses nothing · a port scan of the public interface finds
nothing.

### Epic 5 — REJECTED as written. Vault choice is opening a folder.

**US-5.1 as a generated DSH preset per vault is dead.** Emmanuel rejected a dropdown: switching
vaults means opening a different folder, not picking from a list. Do not re-propose
`~/.dsh/.agent-presets/<vault>/`. What shipped instead is [[decision-0018-dsh-session-vault-router]]:
a Synapse-owned DSH plugin (`@eborja/synapse/dsh-plugin`) that binds each session from
`session.header.cwd`. MCP `roots` and `dsh-mcp-manager` were investigated and ruled out on evidence.

**US-5.2** (the DSH adapter lives in Synapse) still holds — that is the plugin, not a preset generator.

### Epic 6 — Proven on all four harnesses — DONE

Implemented as `mcp/four-harness-e2e.mjs` (also `npm run epic6` and `mcp/four-harness-e2e.test.mjs`).

**US-6.1 / US-6.2 / US-6.3** — four fixture vaults, four harnesses. Each harness: connects · tool
list matches (26 orchestrator tools) · reaches its bound vault · **cannot reach another**, including
when a tool argument names the other. Isolation runs **per harness**. Offline, no API key, handshake
+ tool list only.

Claude Code speaks the modern MCP era (`server/discover`); Cursor, opencode and DSH speak the legacy
initialize handshake. Claude / Cursor / opencode are driven through the generated config's exact
spawn line (`config-spawn`) because those CLIs are not headless without a key — labelled weaker, as
this plan required. DSH is the plugin. We did not wrap the four CLI binaries in containers.

---

## 6. Definition of done

Applies to every epic:

- every acceptance criterion has an executable test, and it passes
- the full suite is green — no epic lowers the existing bar (currently 374)
- `node lib/lint.mjs --strict` reports zero errors
- one PR per epic, reviewable on its own, **never self-merged**
- anything that changes a decision gets a decision note in the same PR
- what was *not* done is stated plainly rather than left implied

---

## 7. Repo conventions

- **Never commit, merge or push to `main`.** One git worktree + branch per epic; open a PR and leave it.
- **`rule-one-writer-per-worktree`** — `git status --porcelain` before touching a tree. Stage by explicit
  path, **never `git add -A`**. Never stash or revert work you did not author.
- **`rule-synapse-human-gated-push`** — framework repo is fully PR-gated. Branch fresh off latest
  `origin/main`, push a new branch, open a PR with base `main`, never merge it yourself.
- Zero dependencies, Node ESM, idempotent, fail loudly.
- Comments state **why**, including the failure mode being prevented. Match `lib/mcp-config.mjs`.
- Engine docs stay generic — no personal paths, no instance-specific content.
- Per-machine generated config is gitignored (`.gitignore:36-38`). Generate it, never commit it.

```bash
npm test    # node --experimental-sqlite --test lib/*.test.mjs lib/ports/*.test.mjs \
            #   lib/durable-spawn/*.test.mjs mcp/*.test.mjs mcp/tools/*.test.mjs
```

---

## 8. Key files

| Path | What |
|---|---|
| `lib/ports/index.mjs` | all five ports declared; **read first** — states the acceptance test |
| `lib/ports/port.mjs` | `definePort` / `assertImplements` / `registry` |
| `lib/ports/vault-store.mjs` | per-vault handles and epochs — Epic 1's foundation |
| `lib/ports/vault-tokens.mjs` | bearer binding — built, not yet in the request path |
| `lib/ports/client-config.mjs` | claude / cursor / opencode config adapters |
| `lib/vaults.mjs` | registry + `sync` / `roster` / `workspace` / `token` |
| `lib/fmt.mjs` | terminal output helpers |
| `mcp/vault.mjs` | **the module-load `VAULT` constant Epic 1 must replace** |
| `mcp/tools/spawn.mjs` | lease/fence — the single-writer guarantee |
| `~/synapse/dsh-synapse` | the DSH adapter to fold in at Epic 5 |
| `~/synapse/deepseek-harness` | DSH source — read-only reference |

---

## 9. Out of scope

| Not in this plan | Why |
|---|---|
| A shared database across vaults | merges four isolation boundaries into one file; turns four independent writers into one queue |
| A Synapse-authored chat UI | would make us a fifth harness — the opposite of harness-agnostic |
| More than one `synapse-core` | one writer per vault database stands |
| Any hosted deployment | local-only is a core intention, not a setting |
| nginx in front | authenticates a connection but knows nothing about vaults — the mapping stays in Synapse either way |
| Fixing `univa`'s lint warnings | pre-existing, unrelated, its own decision |

---

## 10. Known risks

**Epic 1 touches everything**, including the lease path guarding a database with financial records.
*Mitigation:* no behaviour change permitted; the existing suite is the oracle and generated output must
be byte-identical before and after.

**The harness CLIs may resist headless containerisation.** Claude Code, Cursor CLI and opencode are built
for interactive use. *Mitigation:* prove the rig on one harness before building four. If a CLI cannot be
driven headlessly, fall back to asserting generated config plus a direct protocol check — weaker, and
label it as such.

**DSH is pre-release** and its own docs say config keys can move without deprecation.
*Mitigation:* the preset generator lives behind `RosterPort`, so a format change is one adapter edit.
Re-verify against the installed DSH at the start of Epic 5.

**Container-to-container MCP is new ground here.** Nothing in the repo has served MCP over a network yet.
*Mitigation:* Epic 2's gate requires two clients on one server before any container work starts.

---

## 11. Open questions for the human

1. Should Epic 6 gate **each** epic, or run **once at the end**? Per-epic catches breakage earlier and
   costs more upkeep.    answer: once at the end
2. Release `2.0.0` before or after Epic 1? Nothing blocks it, and it restores the real `synapse` command. let's do it afterwards
3. Is US-5.1 the right switching experience — pick a vault when **starting** a session? Switching
   mid-session is a different design. yes picking a vault prior to start is the flow i want

---

## 12. Reference artifacts

- **Build report** — what the 9 merged PRs did · <https://claude.ai/code/artifact/3b2f1392-c33d-4087-97b6-98fd835517f3>
- **Container design** — the four containers in detail · <https://claude.ai/code/artifact/c423b3ba-5881-4885-a4bb-b9cd72f874ee>
- **Build order** — why this sequence · <https://claude.ai/code/artifact/bd46797a-f9f5-4f2a-b05b-cf5abb546ce5>
- **Delivery spec** — stories and the test rig · <https://claude.ai/code/artifact/1e1b8509-e6c6-4493-b50b-8b0923301f10>

---

## 13. First action

```bash
cd /Users/eborja/synapse/synapse-framework
git checkout main && git pull origin main
npm test                              # confirm 374 passing before changing anything
git worktree add -b feat/thread-vault-context ../.worktrees/thread origin/main
```

Then start **Epic 1**, satisfying **US-1.1, US-1.2, US-1.3**.
