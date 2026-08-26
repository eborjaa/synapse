# Changelog

All notable changes to `@eborja/synapse` are documented here. Follows [Keep a Changelog](https://keepachangelog.com/) + [SemVer](https://semver.org/).

## Unreleased

### Added
- **In DSH, the vault now follows the folder you opened.** Synapse ships its own DSH plugin
  (`@eborja/synapse/dsh-plugin`) replacing the generic MCP client row for synapse.

  DSH resolved *skills* per session from the session's working directory but registered *MCP tools* once
  per process, so switching workspace moved the agent list while the tools kept answering from whichever
  vault the machine-wide config named — silently, which is worse than not switching at all. Nothing in
  DSH reads config from the directory you are working in, so this could not be fixed with configuration.

  The plugin routes on `session.header.cwd`: stamped by the host at session creation, validated
  absolute, immutable for the session's life, inherited by subagents, and unwritable by the model. It is
  the same field DSH's own `tool-lsp` uses to route to a per-workspace language-server pool.

  Tools are registered **per session**, agent-scoped, because a vault may carry its own
  `_meta/mcp-plugins/` and two vaults therefore do not publish the same list. One Synapse child is
  pooled per vault, refcounted and idle-evicted (~85 MB each, for vaults actually opened).

  Failure is closed everywhere: a session outside any registered vault, inside an unregistered one, or
  whose child cannot be read gets **no** synapse tools and one line explaining why — never a fallback to
  a default vault. An unregistered vault is reported distinctly from "no vault here", naming
  `synapse vaults add <root>` as the fix. See [[decision-0018-dsh-session-vault-router]].

- **Epic 6 — four harnesses, isolation proven per harness.** `mcp/four-harness-e2e.mjs` (and the
  matching test) drives Claude Code, Cursor, opencode, and the DeepSeek Harness against four vault
  fixtures. Each harness must connect, list 26 orchestrator tools, see only its own vault's agent, and
  still see only that vault when a tool argument names another. Offline: handshake + tool list, no
  API key. Claude Code speaks the modern MCP era; the other three speak the legacy initialize
  handshake. Claude / Cursor / opencode are driven through the generated config's exact spawn line
  (`config-spawn`) because those CLIs are not headless without a key — labelled as such. DSH is the
  plugin. One command: `node --experimental-sqlite mcp/four-harness-e2e.mjs`.

- **One credential can now grant several vaults, and the URL path chooses which one answers.**
  `synapse vaults token work personal` mints a single secret for both, and the address selects:

  ```
  http://127.0.0.1:3000/mcp/work       → the work vault
  http://127.0.0.1:3000/mcp/personal   → the personal vault
  ```

  Previously one token bound exactly one vault, which is what made per-vault client configuration
  unavoidable — every client reaching two vaults needed two rows carrying two secrets, one written into
  each vault's own repo.

  **The credential grants; the path only ever narrows.** A path naming a vault the credential does not
  grant is refused, byte-identically to an unknown token and to a vault that does not exist, so the
  endpoint is not an oracle for which vaults exist on the machine. The id is a single path segment
  compared for exact equality after decoding: `work` never matches `work-archive`, and a traversal
  segment resolves nowhere.

  **No defaults anywhere.** A request with no vault in its path binds only when the credential grants
  exactly one — so every existing single-vault client is untouched. A multi-vault credential asked at the
  bare `/mcp` is *refused* rather than resolved to the first entry, because a client that forgot its path
  segment must not silently read the wrong vault. Tokens minted before this change store a single
  `vaultId` and are read as a one-element grant; nothing is migrated, since rewriting a credential file to
  change a field's shape is a risk with no upside.

  This is a deliberate change to the security posture, reviewed as
  [[decision-0017-path-addressed-vaults]]: **a leaked credential now exposes every vault it grants.**
  What has not changed is the rule [[decision-0010-mcp-2026-07-28-dual-era]] was protecting — the vault
  is something the caller *has*, never something the model *says*. A URL path is transport configuration,
  fixed when a client is configured and unwritable by the model; it is not a tool argument, and no MCP
  parameter is read on the binding path.

  Generated client config still writes stdio rows, which bind by directory and need no running server.

### Fixed
- **The DSH plugin would not load.** Its `Config` was a JSON-Schema-shaped object.
  Cordis validates plugin config through the Standard Schema interface
  (`Config["~standard"].validate`); a plain object has no such method, so pointing a
  DSH profile at `@eborja/synapse/dsh-plugin` threw at load and registered no vault
  tools. `Config` is now a Zod object (this package already depends on Zod 4, which
  implements that interface). Pinned by `dsh/plugin.test.mjs`.

- `synapse vaults token <id> --label "some label"` read the label's value as a second vault id. Bare
  arguments were collected by "does not start with `--`", which the single-id version never noticed
  because it only ever used the first one.

- **Synapse ships as four disposable containers.** `deploy/compose.yml` runs `vpn-sidecar`, `dsh`,
  `synapse-core` and `ollama` over five named volumes, and the same file runs on a laptop and on a home
  server — **only `BIND_ADDR` differs**, and nothing in any image knows where it is running.

  `dsh` owns the network namespace; `synapse-core` and `vpn-sidecar` join it with
  `network_mode: service:dsh`. That is what lets MCP keep binding `127.0.0.1:3000` — the existing
  local-only guard, on the existing code path — while `dsh` still reaches it. Only `dsh` publishes to the
  host, as `${BIND_ADDR}:8080:8080`; core is never given `BIND_ADDR`. `deploy/up.sh` runs
  `deploy/assert-bind.mjs` — the *same* wildcard set the MCP listener refuses — **before** compose
  starts, because Docker publishes the port before Node ever runs. Destroying and recreating every
  container keeps vaults, registry, credentials and rosters. `ollama` sits behind
  `profiles: [embeddings]`; the deterministic core works without it. The `dsh` image is a stub until the
  real harness arrives (`DSH_IMAGE`), and the VPN sidecar idles until `VPN_IMAGE` names a tunnel.
  See [[decision-0016-four-container-deployment]] and [[doc-four-containers]].

- **Exactly one `synapse-core` per config volume is now enforced, not just documented.**
  `synapse-mcp --http` takes `$SYNAPSE_HOME/synapse-core.lock` **before** it listens — so a refused
  second core cannot first steal the port — and releases it on `close()` and on every failed start. A
  second process exits `3` naming the owner. The compose file adds the same rule a layer up
  (`container_name` + `deploy.replicas: 1` make `--scale synapse-core=2` collide).

  The lock records `pid` + `host` + `startedAt`, because in containers a bare pid lies in both
  directions. A hard-killed core leaves the file behind and the restarted core is routinely handed the
  **same** low pid it reads out of it — it signals that pid, finds *itself*, and refuses, crash-looping
  until a retry happens to drift onto another number (observed in the real stack, not theorised).
  Meanwhile two containers each have a pid 7, so trusting `kill(pid, 0)` across namespaces would let a
  second core **steal** a lock a live one holds. Liveness is therefore consulted only for records
  written on this host; a record from another host is refused rather than stolen, and
  `deploy/core-entrypoint.sh` is the one place allowed to clear one — sound only because compose has
  already guaranteed a single core container.

- **`SYNAPSE_SKILLS_ROOT` separates the roster plane from the config volume.** Rosters hung off
  `$SYNAPSE_HOME`, which is also where `tokens.json` (0600) lives, so sharing rosters with `dsh` would
  have meant mounting the credential store beside them. `dsh` now mounts a `skills` volume read-only and
  discovers agents as files, with no MCP call involved. Unset — every host install — it resolves to the
  old `$SYNAPSE_HOME/skills` and nothing moves.

- The published package now ships `deploy/`.

- **Privileged vault and credential operations are a separate MCP catalogue.** An everyday session —
  any of skeleton/standard/full/orchestrator, including a normal bearer against a process started with
  `--surface admin` — never lists `synapse_admin_list` / `_register` / `_mint` / `_revoke` / `_sync`.
  Absence is the boundary, not a handler that refuses. An **admin-scoped** HTTP bearer (minted with
  `synapse vaults token <id> --admin`) upgrades that request to the admin surface: orchestrator plus
  those five tools, and every mutation is reported in the transcript. Generated client config still
  writes only the four everyday surfaces; stdio refuses `SYNAPSE_MCP_SURFACE=admin` at startup because
  it has no bearer. See [[decision-0015-admin-surface]].

- **One Synapse MCP server can now serve many vaults over authenticated local HTTP.**
  `synapse-mcp --http` starts the second `ToolTransportPort` adapter on `127.0.0.1:3000/mcp` by default;
  `--host`, `--port`, `--path`, and `--surface` configure it. The listener accepts loopback or an
  explicitly selected VPN-interface address and refuses `0.0.0.0`, `::`, and empty/wildcard bindings
  before opening a socket.

  Every request's `Authorization: Bearer …` credential is passed as the SDK's `authInfo`, resolved by
  `bearerVaultBinding`, and turned into the `vault` handed to the same `buildServer()` factory stdio
  uses. Tool arguments never enter that path. Missing, unknown, revoked, and no-longer-live vault
  credentials receive a 401 with no vault attached; **unknown token** and **known token whose vault is
  gone** have byte-identical status, body, and challenge, so the endpoint is not a credential-enumeration
  oracle.

  The acceptance test opens one real loopback listener, connects two vaults concurrently, proves a
  request whose arguments name vault B still answers from credential A, and compares HTTP's live tool
  list with a raw-JSON-RPC stdio process. stdio remains the default and still serves both MCP eras.

### Changed
- **A request now carries its own vault.** `mcp/vault.mjs` resolved the vault **once, at module load**,
  into a `VAULT` constant that ~60 references across eight tool modules read. On stdio that was correct
  and [[decision-0010-mcp-2026-07-28-dual-era]] said so — one connection is one process is one vault, so
  "the vault" and "this request's vault" are the same string and a constant cannot be wrong. Off stdio it
  was wrong, and quietly: under an HTTP handler the module loads once and serves many vaults, so every
  tool would answer from whichever vault won the import race.

  A bound vault is now a **value** — `mcp/vault-context.mjs` — passed to `buildServer({ vault })` and
  closed over by each tool handler. The seam sits at the factory because of what the MCP SDK guarantees:
  `McpServerFactory` is invoked **once per HTTP request** under `createMcpHandler` (carrying `authInfo`)
  and once per connection under `serveStdio`. So "one server per bound vault" and "one server per serving
  unit" are the same object, and a per-request vault needs no ambient state to travel in. Two vaults in
  one process share no database handle, no epoch and no cached briefing — not by convention, but because
  they share no name to read.

  **Nothing changes for the existing stdio setup.** `buildServer()` with no vault defaults to the
  env-pinned context, resolved per call. Verified: the full suite passes, generated client config is
  byte-identical, and the live server's **wire surface is byte-identical on all four surfaces**
  (skeleton/standard/full/orchestrator — 3/11/20/26 tools) under raw JSON-RPC in both protocol eras.

  This satisfies the precondition [[decision-0014-multi-vault-amendment]] recorded for the HTTP
  transport; the authenticated adapter above now uses that seam.

### Fixed
- **`synapse_embeddings_status` measured the wrong index.** It printed `vault=<pinned vault>` in its
  header while calling `embeddingsStatus()` with its cwd-first default, so on any server whose working
  directory differed from its pinned vault the header and the measurement disagreed. It is now pinned to
  the bound vault.
- **`synapse_resume_from_handover` read handovers from the wrong vault.** It called `resolveVault()`
  fresh — cwd-first — instead of using the server's vault. Invisible on stdio where the two coincide; a
  cross-vault read the moment they do not.

### Deprecated
- `mcp/vault.mjs`'s single-vault surface — `VAULT`, `AGENTS_DIR`, `HANDOVER_DIR`, `manifest()`,
  `vaultContext()`, `runSynapse()` and the `list*` helpers. They still resolve exactly as before, because
  `<vault>/_meta/mcp-plugins/*.mjs` is a documented extension point with consumers this package does not
  ship. Nothing inside the package imports them any more, and a test enforces that. Plugins should read
  `ctx.vault` (the bound context); `ctx.VAULT`, `ctx.runSynapse` and `ctx.manifest` remain and are now
  derived from the bound vault, so an existing plugin becomes multi-vault-correct unchanged.

### Fixed
- **`synapse install --write` no longer writes a global `export SYNAPSE_VAULT=` into your shell rc.**
  The rc line was `export SYNAPSE_VAULT="<vault>"; source "<agents.sh>"` — a **global pin**, evaluated at
  the top of every interactive shell and inherited by every child process. Three failures fell out of it,
  all silent: running `install --write` from vault **B** re-pinned every shell to B, so work in vault A
  resolved to B wherever `$PWD` detection did not apply; the env-wins resolution paths
  (`resolveVault({preferCwd:false})`, a bare `node lib/<tool>.mjs`) treated *the residue of the last
  install* as deliberate intent; and it was **unfixable by hand**, because the self-heal branch replaced
  any marked line with the freshly generated one, so deleting the export survived exactly until the next
  install.

  The line is now:

  ```bash
  SYNAPSE_VAULT_FALLBACK="/path/to/vault"; source "/path/.../agents.sh"  # @eborja/synapse vault agent commands
  ```

  `SYNAPSE_VAULT_FALLBACK` keeps the safety net the export existed for — a vault to fall back on when
  self-detection comes back empty — without any of its costs. It is **not exported** (nothing inherits
  it), and `__mx_vault` consults it **last**: after the `$PWD` ancestor walk, and after a `$SYNAPSE_VAULT`
  you exported yourself. `$PWD` always wins, an explicit export still outranks the installer, and setups
  that already export `SYNAPSE_VAULT` are unaffected. So `synapse lint` still works from outside every
  vault: `__mx_run` hands the resolved vault to the child as a per-command `SYNAPSE_VAULT=… cmd`
  assignment, which dies with the process.

  **Migration is automatic and reported.** The next `--write` removes the old export, prints what it
  removed and why, and reminds you that already-open shells still carry the exported value
  (`unset SYNAPSE_VAULT`, or open a new terminal). If it re-points the fallback at another vault it says
  so, and says why that cannot redirect anything.

  **New contract on that line** — install rewrites it only when it matches a shape install itself
  generated (that is how the `agents.sh` path stays current across upgrades). A marked line **you** edited
  is treated as yours: install leaves it untouched, prints the line it would have written, and names
  `--force-rc` as the opt-in override — the same "kept, never clobbered" rule `synapse skills` already
  applies to a hand-authored `SKILL.md`. Duplicate marked lines (one rc sourcing two vaults' `agents.sh`)
  collapse to one and are listed; an unmarked foreign `source` is warned about, never touched.

  `lib/install.test.mjs` is new and pins all of it: no outcome ever emits an export, re-running from
  another vault does not redirect, an existing export is healed, a hand-edit is kept, and the dry run
  prints byte-for-byte the line `--write` applies. The shell half runs under bash **and** zsh.

### Changed
- **`doc-install-end-to-end` leads with two quick starts.** New vault vs already-have-a-vault, each a
  command block at the top. The upgrade path was previously after the DSH verification loop, so a
  returning reader never saw it as a start guide.

## 1.1.1 — 2026-08-24

### Fixed
- **`synapse install` now takes `--surface`, and neither command downgrades a vault any more.** Two halves
  of one trap: `install` silently ignored `--surface` (it never passed one, so every run wrote `full`),
  and `mcp-config` reset the surface to `full` whenever `--surface` was omitted. So a vault deliberately
  raised to `orchestrator` was quietly demoted by the very command the upgrade path tells you to run.
  Both now **keep the surface the vault is already on** unless you pass one — a fresh vault still gets
  `full` — and both report which they used and why:

  ```
  surface: orchestrator   (kept from this vault's existing config)
  ```

  When clients disagree on the surface it says so rather than picking one. A junk value already on disk
  is ignored, not propagated. `man` §5 now leads with **HOW TO CHANGE IT** and names both commands, §2
  lists the flag on both, and §0 mentions it at the point of first use — it was previously findable only
  by reading §5 in full.

Install: `npm install @eborja/synapse@^1.1.1`

## 1.1.0 — 2026-08-24

### Added
- **`synapse skills` — your vault's agents become `/synapse-<agent>`.** The harness roster was the one
  consumer surface still hardcoded: four `SKILL.md` files shipped in `.dsh/skills/`, symlinked verbatim by
  `@eborja/dsh-synapse`. A vault defining its own agents (`spec-author`, `qa-lead`, …) got a slash command
  for none of them. Every other surface already read the vault — `agents.sh` `eval`s one verb per
  `agents/agent-*.md`, the launcher renders the briefing into opencode's and Cursor's native identity
  formats, and `synapse_list_agents` reads the same frontmatter — so this closes the fourth against a
  contract `decision-0008` already set: *"the package declares the roster; the harness consumes it …
  instead of a hand-maintained list of names."*

  ```bash
  synapse skills                            # dry run
  synapse skills --write                    # → <vault>/.dsh/skills/synapse-<agent>/SKILL.md
  synapse skills --write --agent oracle     # just one
  synapse skills --write --out ~/.dsh/skills
  ```

  - **`synapse install --write` runs it as its 5th step**, so a fresh vault is wired by the same one
    command that writes the MCP configs.
  - **Default target is the vault REPO ROOT's `.dsh/skills`** — DSH discovers that as `project-dsh`, its
    highest-ranked root, so the common case needs no symlink and no YAML. The repo root and not `vaultDir`
    on purpose: DSH resolves that root by walking up from its launch directory for `.git`, which under the
    nested layout lands on the repo root rather than `context-vault/`. With no `.git` anywhere DSH falls
    back to its launch directory, so the command warns and points at `--out ~/.dsh/skills` — the
    user-scoped root `@eborja/dsh-synapse` links, which works from anywhere.
  - **The body is a pointer, not a payload.** Step 2 of every generated procedure is `synapse_brief` with
    that agent's own id and `profile`; the render engine stays the single source of the real context.
    Skill bodies have no size cap, so a `SKILL.md` that grows toward briefing size re-creates the exact
    context problem the engine exists to solve.
  - **Every branch keys on declared frontmatter, never on prose.** `delegates_to` adds the three-call
    delegation spine (and names the targets); `uses_tools` containing `tool-lint`/`tool-git` decides
    whether the role gets verify+record steps and "propose, do not push" or a flat **"never mutate"** — a
    read-only agent is never handed a step that invites a write; `addressable: true` adds the
    publish-in-thread duty; `outputs` adds "what you produce".
  - **A skill the package hand-authored is installed verbatim, never generated over.** DSH ranks the
    project root (`<repo>/.dsh/skills`, 100) **above** the user root (`~/.dsh/skills`, 400) that
    `@eborja/dsh-synapse` symlinks the shipped skills into — so generating over `synapse-oracle` and
    friends would have *shadowed* the tuned versions with generic ones. Those four are copied through
    as-is (reported as `shipped`); the template is the floor for agents the package ships nothing for.
  - **Hand-authored skills are never overwritten** without `--force`. The marker is an HTML comment on the
    first body line, deliberately **not** a frontmatter key: DSH drops a whole skill on a malformed
    frontmatter value, so nothing is added to a block whose parser we do not control. The four shipped
    skills — tuned against observed local-30B failures (claim conflated with spawn, polling
    `synapse_spawn_status` for a doer nobody launched, `refused: "held"` treated as fatal) — report as
    `kept` and stay hand-authored.
  - **An agent that cannot produce a valid skill is skipped loudly.** DSH validates `name` against
    `^[a-z0-9]+(?:-[a-z0-9]+)*$` and drops a failure at load with only a warning; an id like
    `agent-QA_Lead`, or an agent with no `purpose`/`title` to route on, now warns at generation instead.
  - Rationale: `_meta/decisions/decision-0011-generated-harness-skills.md`. 17 new tests (242 total).

### Fixed
- **`mcp-config` / `install` no longer delete other MCP servers.** Regenerating rewrote `.mcp.json` and
  `.cursor/mcp.json` **wholesale**, so any server a user had configured by hand — github, postgres, figma,
  a vault plugin — was silently dropped. A vault is a normal repo and those rows are common. Both files are
  now MERGED: only the `synapse` entry is ours, everything else is carried through and reported
  (`kept 2 other server(s) — github, postgres`). opencode was already merged and is unchanged. An
  unparseable existing file is still replaced, but now says so first instead of doing it quietly.
- **A customised agent no longer gets the shipped skill.** `synapse skills` installs the package's
  hand-authored `SKILL.md` verbatim only while your agent still MATCHES the shipped one. Edit
  `agent-oracle.md`'s purpose, profile, `delegates_to`, `uses_tools`, `addressable` or `outputs` and the
  command warns and generates `/synapse-oracle` from **your** definition — a tuned skill describing a role
  you no longer have is worse than a generic one that is accurate. Comparison is over the frontmatter the
  template actually reads, so editing an agent's prose body still yields the shipped skill (the body
  reaches the model through `synapse_brief`, not through the skill).
- **A `fat` agent is no longer told to escalate to `fat`.**
- **`synapse --version`.** There was no way to ask which engine a vault actually resolves — the first
  thing anyone checks after an upgrade. `--version` / `-v` / `version` print it.
- **A `mcp-config` dry-run now says whether anything would change.** It ended with "Re-run with --write
  to apply" unconditionally, even when every file was already current, so a dry run could not be used to
  verify a vault was wired. It now reports `N file(s) would change` or `All current — nothing to do.`
- **Documented the upgrade path, which did not exist.** Every guide assumed a new machine and a new
  vault. Someone bumping an existing vault to 1.1.0 was told nowhere that `/synapse-<agent>` needs
  `synapse skills --write` — `npm install` alone leaves the skills absent and nothing says so. The install
  guide gains an **Upgrading a vault you already have** section (with a from-which-version table),
  linked from the README and summarised in `synapse man`.
- **Companion fix in `@eborja/dsh-synapse` 0.1.1** (separate repo): it resolved the vault as
  `$SYNAPSE_VAULT || cwd`, and `synapse install --write` *exports* `$SYNAPSE_VAULT` — so on any machine
  that already had a vault, the documented `cd my-vault && npx @eborja/dsh-synapse install --write`
  silently wired a **different** vault into `~/.dsh`. Order is now `--vault` → cwd → `$SYNAPSE_VAULT`,
  matching this package's own `resolveVault({preferCwd:true})`, and it warns when they disagree. Upgrade
  to 0.1.1 before re-running it.

### Changed
- **`synapse man` now tells you where to start.** It had no entry point: `synapse install` and
  `synapse setup` appeared nowhere in it, `mcp-config` only in passing, and the MCP surfaces were a single
  env-var mention. Adds **§0 START HERE** with the ordered install and an explicit answer to *"which of
  setup / install / mcp-config do I need?"* — `mcp-config` writes only the MCP client configs and is enough
  on its own; `install` is a superset that also brings the `agents.sh` shell CLI; `setup` is unrelated and
  provisions the *semantic* runtime. Also notes that `init` ships **zero migrations**, so a fresh vault has
  no database and does not need one.

  Adds **§5 MCP SURFACES**, framing a surface as a *permission dial* rather than a feature flag — a tool
  outside the surface is never registered, so it cannot be called. Tool counts are measured, not assumed
  (skeleton 3 · standard 11 · full 20 · orchestrator 26), with how to raise it
  (`mcp-config --write --surface orchestrator`, or `$SYNAPSE_MCP_SURFACE`) and which to pick.

### Added
- **`doc-install-end-to-end`** — the ordered path from a bare machine to a vault whose agents you can
  delegate to from the DeepSeek Harness. Six steps, each with the check that catches a silent failure, and
  it states up front that steps 1–3 are the whole product for anyone not using DSH. Verification reads the
  SQLite databases rather than the chat transcript, because a model can report a delegation succeeded when
  it did not. Troubleshooting covers `NO_ADAPTER` after a provider rename, `claim_and_brief` launching
  nothing, a briefing truncated by `spill-policy`, and a lease stranded by an interrupt.

  Step 2 opens with a table disambiguating the three commands people conflate: `mcp-config` writes only the
  MCP client configs, `install` is a superset that also brings the shell CLI, and **`setup` is unrelated to
  both** — it provisions the semantic runtime and never touches an MCP config. `setup` had appeared exactly
  once, buried in the optional semantic-recall step, which is precisely how it gets mistaken for a wiring
  command.

  Written against a scratch vault rather than from memory, which corrected three things it had wrong:
  `init` ships no migrations and no database; `init` itself recommends `mcp-config --write` rather than
  `install --write`; and the orchestration databases (`durable-spawn.db`, `episodes.db`) are not
  `db/synapse.db` and self-create on first use.

Install: `npm install @eborja/synapse@^1.1.0`

## 1.0.0 — 2026-08-23 (dual-era line)

> `0.19.x` remains the legacy line. A consumer pinned to `^0.19.0` is unaffected and stays there until
> they choose to move — the two ranges do not overlap.

### Changed
- **The MCP server now speaks BOTH protocol eras from one process.** Swapped
  `@modelcontextprotocol/sdk` (v1, permanently frozen at `2025-11-25`) for `@modelcontextprotocol/server@2`
  and `serveStdio(factory, { legacy: 'serve' })`. Claude Code gets the stateless `2026-07-28` path;
  Cursor, opencode and DeepSeek Harness — all still legacy-only — keep working untouched. The v1 SDK moves
  to `devDependencies`, where it now serves as the legacy client lane in `mcp/smoke.mjs`, so both eras are
  tested against one binary.

  **One wire change, and only one:** every tool's `inputSchema` now declares JSON Schema `2020-12` instead
  of `draft-07`, because the v2 SDK emits the newer dialect. Verified exhaustively — of 120 differing lines
  across all four surfaces, all 120 are the `$schema` declaration. Tool names, descriptions, properties,
  required fields, protocol version, capabilities and instructions are byte-identical.

- **`mcp/server.mjs` is now a startup shim over a `buildServer()` factory** (`mcp/build-server.mjs`).
  Building a server is a call, not a side effect of importing a module, because the stateless transport
  invokes a factory per connection. Plugin *modules* load once at startup — so a broken plugin still fails
  the process — while plugin *registration* happens inside the factory, which stays synchronous on purpose:
  the SDK would permit an async factory, but keeping it allocation-only means no I/O per connection and no
  window where a half-registered server reaches a client. A plugin with an async `register()` is now
  rejected with an explanatory error.

### Added
- **`mcp/conformance.mjs`** (`npm run conformance`) — snapshots the wire surface over raw JSON-RPC with no
  SDK involved, probing both eras in separate processes (a connection is pinned to one era by its opening
  message). This is the SDK-independent baseline that proved the refactor and the swap did not move the
  wire, and it is worth re-running before any change under `mcp/`.
- 16 tests: 10 pinning the factory contract, 6 pinning the dual-era guarantee end-to-end against a real
  server process — both eras respond, both expose the same tools, a connection is single-era, and an
  unsupported revision is refused with the supported list.
- **`decision-0010-mcp-2026-07-28-dual-era`** — the plan for adopting MCP's new stateless standard. Not yet
  implemented; this branch tracks it separately from the 0.19.0 legacy line.

  Two findings shape it. Our `@modelcontextprotocol/sdk@^1.30.0` **can never** speak 2026-07-28 — support
  lives in a repackage (`@modelcontextprotocol/server`/`client`/`core` v2), not a version bump. And three
  of our four clients are legacy-only (Cursor 3.13.25, opencode 1.18.19, DSH `dsh-mcp-client` 0.0.1-rc.1);
  only Claude Code 2.1.240 is dual-era. Since the spec's matrix says **legacy client + modern server
  fails**, a modern-only server would break Cursor, opencode and the whole DSH integration.

  So: adopt it as a **dual-era** server. `serveStdio(buildServer, { legacy: 'serve' })` — the default —
  serves both eras from one factory with no branching, verified empirically against our exact
  `registerTool` shape. Most of the spec does not reach us: header routing and `Mcp-Session-Id` are
  Streamable-HTTP only (stdio carries metadata inline, no header layer), MRTR replaces server-initiated
  requests and we initiate none, and we use no sampling/elicitation/roots/resources/prompts. The
  substantial change is one file — `mcp/server.mjs` from module-level singleton to a `buildServer()`
  factory, with plugin loading split from registration. `lib/mcp-config.mjs` needs no change; the generated
  client configs stay byte-identical.


Install: `npm install @eborja/synapse@^1.0.0`

## 0.19.0 — 2026-08-22

### Added
- **DSH agent skills** (`.dsh/skills/synapse-{oracle,curator,ingester,reconciler}/SKILL.md`). The vault's
  four agents as DeepSeek Harness skills, so `/synapse-oracle` (and friends) load the role's procedure and
  boundaries in a harness that consumes Synapse over MCP. They live in `.dsh/` rather than `skills/`
  because that directory holds vault-typed `type: skill` artifacts; these are harness assets, and `.dsh/`
  is now in `package.json` `files[]` so they ship to consumers.

  Written against the failure modes observed driving a local 30B (qwen3-coder) through the harness:
  - **Delegation is spelled out as three separate calls.** `synapse_claim_and_brief` does *not* start a
    worker — it takes the lease, opens the episode and returns the briefing. Every probe run conflated
    the claim with the spawn: the model claimed, then polled `synapse_spawn_status` for a doer nobody had
    launched, burned the lease's TTL, and finally did the analysis itself. The skills now name the
    harness's own `subagent` tool (with `run_in_background: false`) as the middle step.
  - **`refused: "held"` is recoverable.** A claim whose response is lost still creates the lease, so the
    natural retry collides with the caller's own lease. The skills now say to reuse the held
    `owner`/`token` and continue, rather than re-claiming under a new job id.
  - **Agent ids must exist.** A run invented `spec-builder` and then called `synapse_create_agent` twice
    to conjure specialists; the skills now require checking `synapse_list_agents` and reusing `oracle`.
  - **Working economy.** One brief per hub, `synapse_recall` for the delta, ids over file paths, and
    "extra tool calls are not extra diligence" — a bloated context measurably degrades a local model's
    answer.

- **Two notes on the DeepSeek Harness integration** (`notes/note-deepseek-harness-integration.md`,
  `notes/note-dsh-extension-seams.md`), peers to `note-synapse-harness-playbook`. The first records how a
  vault reaches DSH (MCP is the only bridge), the delegation loop as it actually behaves, and a verified
  end-to-end result: a two-domain run producing **2 claims → 2 subagents → 2 releases**, 12/12 assertions
  green, distinct fence tokens, both episodes closed by the model, no leaked lease. It names the three
  conditions that each had to hold — a model that can carry the procedure, a subagent provider that
  actually resolves (every child died instantly with `NO_ADAPTER` after a provider rename, which is the
  first thing to check when delegation "runs" but yields nothing), and `run_in_background: false`. It also
  resolves two open questions (presets **do** inherit the profile-level MCP entry; skills need no
  force-loading, since the harness injects a skill catalog the model reads unprompted) and records two
  still open (the 60 s `toolCallTimeoutMs` that can strand a lease mid-claim, and the Stop-hook guard not
  firing on an interrupt). The second maps DSH's extension seams — plugins, hooks, skills, presets, spill
  policy — to the Synapse concern each one should carry.

- **README rewritten around getting started fast, and corrected where it had drifted.**
  - **`synapse init` is now documented** — it shipped but the README never mentioned it, so both
    onboarding paths walked people through a manual `mkdir` / `npm init` / `cp context.manifest.example`
    dance instead of the one command that scaffolds a working vault (37 files: manifest, the four agents,
    the rules, starter hubs). Quick start now leads with it, and notes that it fills in only what is
    missing, so it is safe to re-run after an engine bump.
  - **A new "Use it from your AI tool (MCP)" section.** MCP is how most people will actually use Synapse,
    and it appeared only as one bullet at the very bottom. Now covers the generated client configs
    (`.mcp.json` / `.cursor/mcp.json` / `opencode.json`), the `full` vs `orchestrator` surfaces, **DeepSeek
    Harness** wiring (which has no generated config — it takes a `dsh-mcp-client` row in
    `cordis.patch.yml`), the `.dsh/skills/` harness skills, and the point that trips everyone: delegation
    is **three** calls, because `claim_and_brief` returns a briefing and launches nothing.
  - **Version pins no longer rot.** Quick start installs `@eborja/synapse` unpinned; the explicit pins
    that remain (the `dependencies` example, the git-SHA install) move to `^0.19.0`.
  - **Command table completed** — `init`, `handover-task`, `journal` and `man` were missing. Every one of
    the 16 documented subcommands was verified to exist in `synapse help`, and every relative link in the
    README was verified to resolve.

### Changed
- `.gitignore` now covers `.opencode/agents/`, which `agents.sh` writes per launch as a temporary agent
  definition (the file announces its own auto-deletion) and which was showing up as untracked noise.

Install: `npm install @eborja/synapse@^0.19.0`

## 0.18.2 — 2026-08-21

### Fixed
- **The spawn tools now accept the SHORT agent id they advertise.** `synapse_claim_and_brief` and
  `synapse_spawn` both document `agent` as *"e.g. 'spec-builder' or 'agent-spec-builder'"*, but forwarded
  the raw value to the render engine, which resolves only the full artifact id — so a short id died with
  `render-failed: unknown artifact(s): oracle` while the identical call with `agent-oracle` rendered
  fine. `normalizeAgentId()` already existed and was used by `synapse_brief`, handover, authoring and
  new-note; the spawn path simply never called it. Now normalized once at each handler entry, so the
  claim, the render **and** the episode record all carry the full id. Latent since the spawn tools landed
  (0.9.0/0.10.0) — it only became fatal once the renderer began rejecting unresolved roots instead of
  skipping them. Observed live from an orchestrator in the DeepSeek Harness, which naturally calls the
  tool with the short id its own `synapse_list_agents` output shows.

Install: `npm install @eborja/synapse@^0.18.2`

## 0.18.1 — 2026-08-20

### Fixed
- **MCP config is now provider-AGNOSTIC — synapse no longer owns your model runtime.** 0.18.0 (and
  0.17.2) always injected a native `localhost` ollama provider into the generated `opencode.json`. On any
  non-local setup that was wrong: a laptop reaching its models over Tailscale got a hardcoded `localhost`
  and every model 404'd (`model 'qwen3.6-256k' not found`), even though the MCP tools connected fine.
  `mcp-config` / `install` now write only the `synapse` MCP entry and **never clobber a provider you
  configured** (project OR global `~/.config/opencode/opencode.json`). A provider is seeded in exactly one
  case — a *total vacuum* (no provider anywhere), where a native `localhost`/`api` provider is the correct
  zero-config local default and there is nothing to overwrite (`SYNAPSE_OLLAMA_URL` overrides the host).
  Otherwise synapse stays hands-off and, if the effective provider is on ollama's `/v1` path, prints an
  **advisory** (never a mutation) pointing to the native `/api` switch. New helpers `nativeOllamaProvider`
  / `providerUsesV1` are unit-tested; the fix belongs in your global opencode config so every vault benefits.

## 0.18.0 — 2026-08-20

### Added
- **`synapse install --write` now wires the MCP clients too — the fix is ready-to-go out of the box.**
  Install was three steps (shell rc, Claude `settings.json` reach, `CLAUDE.md` pointer); it now does a
  fourth: generate `.mcp.json` / `.cursor/mcp.json` / `opencode.json` for the current vault — identical
  output to `synapse mcp-config --write`. So a single `synapse install --write` makes the synapse MCP
  tools (and, on a local-Ollama vault, opencode's native-provider fix from 0.17.2) work in Claude Code,
  Cursor, and opencode without a separate command. The dry-run (`synapse install`) previews the files.
  `synapse mcp-config` stays as the standalone for regenerating with a different `--surface` / `--client`.

### Changed
- **`lib/mcp-config.mjs` refactored into importable functions** (`buildMcpTargets`, `applyMcpTargets`)
  behind an `isMain` guard — `synapse install` calls them in-process, so the generation logic lives in
  one place, is unit-tested (`lib/mcp-config.test.mjs`), and is not shelled out to a subprocess.
- **Generated MCP client configs are git-ignored.** `.mcp.json`, `.cursor/mcp.json`, and `opencode.json`
  carry absolute, machine-specific paths and are produced by `mcp-config`/`install` per-machine — they no
  longer belong in the repo. (A stray committed `opencode.json` was untracked.)

## 0.17.2 — 2026-08-20

### Fixed
- **opencode MCP tools now actually execute (native Ollama provider).** `synapse mcp-config --client
  opencode` seeds the NATIVE ai-sdk Ollama provider (`ollama-ai-provider-v2`, the `/api` endpoint) when
  the vault has no provider of its own. Ollama's OpenAI-compatible `/v1` STREAMING path silently drops
  tool-call delta chunks (opencode #20995, ollama #5769), so MCP tools never fired — the model answered
  in prose and the `tools/call` never reached the server (confirmed by proxy capture: `/v1` stream
  returned the tool_call but opencode did not dispatch it). On `/api` the round-trip works: verified live
  — a local qwen model calls `synapse_list_agents` in the opencode TUI and returns the real 14 agents.
  The config is MERGED, never overwritten, so an existing model/provider is preserved.
- **opencode now launches the TUI, and the briefing is the agent's IDENTITY (not a file it reads).**
  Two bugs with one symptom. `opencode run` is one-shot, so the session answered and exited — the root
  command is the TUI. And the briefing was passed with `--file`, which makes it an ATTACHMENT to the
  user message: the model read it as a document rather than becoming that agent, and said so —
  *"looks like the file that was read is a briefing for a QA Lead… are you setting me up against the
  role I'm playing?"*. The briefing is now written as an opencode **agent definition**
  (`<vault>/.opencode/agents/synapse-<agent>.md`, whose body IS the system prompt) and selected with
  `--agent`, mirroring the cursor branch's `.mdc` rules file. Temp file, trap-cleaned on exit.
- **`synapse mcp-config` now supports opencode.** opencode reads neither `.mcp.json` nor
  `.cursor/mcp.json` — it needs its own `opencode.json` with an `mcp` key, `command` as an ARRAY and
  `environment` (not `env`). Without it the synapse tools simply were not available in opencode.
- **`mcp-config --surface orchestrator` was rejected.** The validator still listed only
  skeleton|standard|full; `orchestrator` has existed since 0.10.
- **Extra plugin env is no longer dropped between clients.** A vault MCP plugin can require its own env
  (eb's zephyr plugin needs `ZEPHYR_MCP_DISABLE=1`), and a missing one makes the plugin throw and takes
  the WHOLE server down. `mcp-config` now accepts repeatable `--env KEY=VAL` and carries over env
  already present in any sibling client config.
- **opencode's session no longer exits immediately (`--interactive` restored).** `opencode run` is
  ONE-SHOT by default; `--interactive` is what keeps the session open. It was dropped while fixing the
  argv order (on a wrong reading of the flag list), so the TUI silently stopped appearing — the run
  still answered, which is why only a human noticed. `--dir <vault>` was dropped the same way and is
  restored. Both are now asserted in `lib/launcher.test.mjs`.
- **opencode was being handed a Claude Code flag.** `auto`/`bypass` passed
  `--dangerously-skip-permissions`, which is not in opencode's flag set — a no-op, so both modes
  silently behaved like `manual`. opencode's real flag is `--auto`. A test now guards each CLI against
  receiving another CLI's flags.

### Notes
- Both regressions came from the same mistake: reading `opencode run --help` through a PARTIAL grep and
  concluding two real flags did not exist. The complete flag list is the source of truth, and the new
  per-CLI argv assertions now encode it so a wrong reading cannot silently ship again.

## 0.17.1 — 2026-08-20

### Fixed
- **opencode launch: the task was read as a filename.** `qa-lead "hi" --cli opencode` failed with
  `Error: File not found: hi` — opencode's `--file` is an ARRAY flag, so a task placed after
  `--file <briefing>` was swallowed as a second filename. The message now comes first
  (`opencode run "$task" … --file <briefing>`); the no-task branch is POSIX (no arrays). Verified live
  against opencode 1.18.19. (This entry originally claimed `--dir` was not an opencode flag — that was
  wrong, from a partial reading of the help; see 0.17.2, which restores it.)

### Added
- **CLI runtime sinks are now tested for all three CLIs.** A `SYNAPSE_PRINT_LAUNCH=1` seam prints the
  exact argv each `--cli` (opencode/claude/cursor) would exec, and `lib/launcher.test.mjs` asserts the
  shape — task not swallowed, briefing attached, no flag leak — for each. These are the argv-shape bugs
  the binaries can't reveal in CI.
- **bash + zsh parity is asserted.** The launcher is a sourced interactive tool; the tests re-run every
  invariant under each available shell and assert zsh builds byte-identical argv to bash. The header no
  longer claims POSIX-sh support (a strict non-array shell cannot even parse the zsh completion block —
  it was never a real target).

## 0.17.0 — 2026-08-20

### Added
- **`synapse man`** — a full, self-contained manual: the launcher grammar (target-vs-task rule, every
  flag, examples), all `synapse` subcommands, booting from a handover, the memory/live-context MCP tools,
  and vault resolution + env vars. Complements the quick `synapse help`. Regression-tested for coverage.
- **CLI is now tested.** The sourced launcher (`agents.sh`) had ZERO tests — the reason three arg-parsing
  bugs shipped (a bare task read as a note id, `--profile` leaking into the task, `--handover` dropped
  behind a bare task). `lib/launcher.test.mjs` drives the real sourced launcher in bash against a temp
  vault and pins the whole grammar; `lib/note-as-task.test.mjs`, `lib/vault-root.test.mjs`, and
  `mcp/tools/agents.test.mjs` (the on-demand-fetch contract) close the other gaps. 180 tests total.
- **Documentation.** New `docs/doc-agent-memory.md` (the freshness / episodic / on-demand / recall /
  suite-routing / handover stack) and `docs/doc-mcp-tools.md` (every `synapse_*` MCP tool grouped by
  surface: skeleton ⊂ standard ⊂ full ⊂ orchestrator), both wired into `hub-synapse`; and
  `docs/doc-cli-reference.md` gains the full launcher grammar + the new subcommands (`embeddings-status`,
  `handover-task`, `man`). The MCP doc is cross-checked against the smoke test's authoritative tool set.
  New ADR `decision-0009-agent-memory-from-waku` records the DESIGN LINEAGE: the memory model came from
  Waku's three-memory + retrieval-gate approach, adapted for a team-shared linted vault (deterministic
  gate, propose-only) — including what was deliberately NOT adopted (auto-consolidation, a per-turn LLM
  gate, the full eval loop) and why.
- **A handover can now carry additional inline comments.** `<agent> [moc/hub] "steer this launch"
  --handover <ref> --cli <cli> --profile <p>` composes them: the handover is the task-of-record (its
  successor protocol + body), and the inline string is appended under an "Additional instruction for THIS
  launch" header. Previously a bare task and `--handover` conflicted and the handover was silently
  dropped; now neither input is lost, and a moc/hub target still fuses alongside.

### Fixed
- **A one-word task was misread as a note id by the launcher.** `qa-lead "hi" --cli opencode` failed with
  `unknown artifact(s): hi` — the launcher grabbed the first lowercase word as a fusable TARGET (a note to
  render) regardless of whether it resolved. Now the first positional is treated as a target only when it
  is `hub-*`/`moc-*` (convention — a typo'd one still errors clearly) or actually resolves to a note file
  in the vault; anything else, including a bare prose task, falls through to the task. So `qa-lead "hi"`,
  `qa-lead moc-sensors "hi"`, and `qa-lead moc-sensors` all do the right thing.
- **The on-demand "Fetch before you act" pointer recommended a call that did not exist.** The pointer
  (and the doc-fetch line render since 0.13) told the agent to run `synapse_brief(note: "<id>")`, but
  `synapse_brief` had no `note` param — the fetch failed with "needs agent, not note" and the agent fell
  back to reading files by hand, so the whole on-demand fetch path was broken in practice. `synapse_brief`
  now accepts `note` (mutually exclusive with `agent`) and renders that single note in full — asking for a
  note by id IS how you read it. Caught in a live agent session (not by tests — every test passed because
  none drove the call the pointer names); a new contract test now asserts the call an on-demand pointer
  recommends is one the surface can actually service.
## 0.16.1 — 2026-08-20

### Fixed
- **`cwd` now wins over an exported `$SYNAPSE_VAULT` for every interactive tool.** `resolveVault` defaulted
  to env-first, so a `$SYNAPSE_VAULT` exported in a shell rc silently overrode the vault you had `cd`'d
  into — a render/augment/recall could brief from the WRONG vault with no warning (observed live: an
  exported override pinned to vault A while working in vault B). The default is now `preferCwd: true`,
  matching the launcher (`agents.sh` was already cwd-first) — so the two resolvers finally agree, and the
  env var is a FALLBACK (used only when cwd is not inside a vault) rather than an unconditional override.

  The **MCP server stays env-pinned** (`mcp/vault.mjs` passes `preferCwd: false`): it is launched by the
  harness with `$SYNAPSE_VAULT` set in `.mcp.json` and cannot `cd`, so its config env is authoritative.
  In-process libs the server calls (recall) now resolve through the server's pinned context rather than
  re-resolving cwd-first, so a single env-pinned server can never split-brain across two vaults.

### Notes
- To pin a vault deliberately, still `export SYNAPSE_VAULT=…` (or prefix one command) — it just no longer
  overrides a vault you are standing in. A consumer that hard-exported it in a shell rc can drop that
  line: `cd` into the vault and tools resolve it. `agents.sh` still sources fine outside any vault (it
  prints an info line and resolves per-call).
## 0.16.0 — 2026-08-19

### Added
- **Boot an agent FROM a handover note — `--handover` / `synapse handover-task`.** A handover note IS a
  task ("read this, confirm the locked decisions, resume from Next actions"). Synapse could render and
  augment a `--task` string, but had no user-friendly way to say "use THIS note as the task" — so it
  leaned on the REL launcher's `--handover`. Now it is first-class and shared across all three surfaces:
  - **launcher:** `qa-lead --handover <ref> --cli cursor` (also `--prompt-file <path>` for any note, no
    protocol prepend). `--profile` is now consumed from ANY position, not only first.
  - **CLI:** `synapse handover-task <ref> [--plain]` prints the note as a task; `synapse augment <agent>
    --handover <ref>` briefs directly from it.
  - **MCP:** `synapse_resume_from_handover` now resolves an arbitrary path (incl. a skipDir like
    `journal/`), strips frontmatter, and briefs via **augment** (the note text becomes the recall query),
    where before it only read `inbox/handovers/` and used render.
  - `lib/note-as-task.mjs` is the shared core: `resolveNoteRef` (path anywhere → fuzzy slug in
    inbox/handovers/) + `taskFromNote` (strip frontmatter, prepend the successor protocol).

### Notes
- Resolution tries the ref as a PATH first (as-is / cwd-relative / vault-relative), so a handover kept
  anywhere resolves — then, for a handover, a fuzzy slug match inside `inbox/handovers/`. Ambiguous slugs
  are reported, never guessed.
- This is the synapse-native equivalent of the REL launcher's `--handover`, and it carries synapse's own
  render features the REL engine lacks — the same launch surfaces the on-demand "Fetch before you act"
  checklist and the memory brief. Verified live on rel-context-eb against a handover in `journal/`:
  14 rules, the handover as the task + recall query, the on-demand checklist, and semantic recall.
## 0.15.0 — 2026-08-19

### Added
- **Suite-affinity routing in `synapse_recall`.** When a task NAMES a suite (its `suite/<x>` vocabulary
  appears in the task text), recall biases its semantic hits toward that suite. Raw cosine could rank an
  adjacent suite higher — an "alerts" task returning *sensors*-notification notes because both mention
  "notifications" — and this corrects the ORDER without hard-filtering, so a genuinely relevant
  cross-suite note still surfaces. The chosen suites are returned as `routedToSuites` so a wrong route
  is visible. `suitesNamedBy()` is exported and is a pure, deterministic keyword match (no model, no
  index) — the same family as hub inference.

### Changed
- Suite routing is computed in `recall()` itself, independent of the semantic layer, so `routedToSuites`
  is reported even when there is no index/Ollama (the boost simply has nothing to reorder).

### Notes
- Verified live: "the alerts fanout list is missing notifications after retraining" returned
  sensors-notification notes before, and `workflow-alerts-*` / `user-story-alerts-*` after — routed to
  `alerts`, no change to the other domains, and a task naming no suite is unaffected.
## 0.14.0 — 2026-08-19

### Added
- **`synapse_recall` — the top-up when the task shifts mid-session.** A briefing is rendered ONCE, from
  (agent, hub, task) at dispatch. Ten turns later the agent has moved to a different subtask with its
  context frozen at turn 1 — the root cause of drift. `synapse_recall({task})` returns only the DELTA
  for the current subtask, never the spine the agent already holds, unifying all three memories:

  - **semantic** — notes relevant to the new subtask (embedding recall)
  - **procedural** — on-demand rules the subtask now triggers (deterministic keyword match — the same
    logic validated for hub inference; offline, no model, a wrong guess is visible)
  - **episodic** — whether this was already done, from `synapse_history`

  **The gate is built in:** if nothing clears the bars — no hit above the similarity floor, no trigger
  matched, no prior episode — it says *"Nothing new — your current briefing already covers this"* rather
  than manufacturing filler. That is the "does this turn need memory at all?" check, answered from the
  result instead of a separate model call. Registered on every read surface; call it whenever the topic
  shifts. `lib/recall.mjs` exposes `recall()` and `triggeredRules()` directly.

### Notes
- Recall degrades exactly like augment: no index or no Ollama → the semantic half returns a skip note
  and the deterministic halves (triggered rules, prior work) still answer. It never throws.
- `triggeredRules` considers ONLY `on_demand` notes, so an ordinary always-loaded rule never fires a
  spurious "fetch me" — the trigger list is precisely the rules whose bodies are NOT already in context.

## 0.13.0 — 2026-08-19

### Added
- **On-demand notes: carry the trigger, fetch the body.** A note (usually a rule or doc) can declare

  ```yaml
  on_demand: true
  trigger: "before posting a Zephyr execution comment"
  ```

  and `render` emits, in EVERY profile, a ~35-token pointer under a **"Fetch before you act"** checklist
  instead of the body:

  ```
  - **before posting a Zephyr execution comment** → `synapse_brief(note: "rule-...")`
  ```

  The failure mode this fixes is not "the agent forgot a rule it could see" — it is "the agent never
  knew the rule existed". A trigger names the SITUATION, so it is short by nature, and the payload (a
  template, a long procedure) stays out of context until the moment it applies. Measured motivation: one
  formatting rule in a live vault was ~5,900 rendered tokens — larger than most agents' entire briefing
  — and it pushed ALL of an agent's rules out of every render.

  - **Reading it** is just asking for it by id (`synapse render <id>` / `synapse_brief`) — that renders
    the full body. Requesting a note explicitly is the fetch.
  - **Triggers are STICKY**: an on-demand note referenced by ANY note already in the closure joins it,
    regardless of hop distance or profile depth — because a rule that reached the briefing and says
    "fetch X before writing" must have X's trigger reach the agent too, or the pointer dangles. They are
    never budget-trimmed (a ~35-token pointer is not worth cutting) and `on_demand` outranks
    `mandatoryFull` (a template that must be followed exactly is best read fresh, not recalled).

### Notes
- `on_demand` is orthogonal to `mandatoryFull`: "always included" and "always inlined" are different
  claims. A guardrail can be both binding AND on-demand — its trigger always reaches the agent, its
  template does not.
- The sticky pass follows the outbound link fields of the profile's enabled roles, derived from the
  profile itself — not from the optional `referenceRoles` manifest key, which many vaults omit.

## 0.12.0 — 2026-08-19

### Added
- **Episodic memory — synapse now remembers what agents actually did.** It had procedural memory
  (agents/rules/skills — *how to act*) and semantic memory (notes + embeddings — *what is true*), but no
  record of what *happened*. Every session started amnesiac: a lead re-planned work a doer finished
  yesterday, and the only cure was a human writing a handover note by hand.

  - **`synapse_history`** (read surfaces) — search the record of completed work: the task, how it ended,
    a summary, and what it touched. Keyword search, so exact ids (`REL-38837`) match reliably.
  - **`synapse_log`** (read surfaces) — record work you did yourself.
  - **`lib/durable-spawn/episodes.mjs`** — the store, usable directly.

- **Capture is automatic for delegated work.** An episode opens inside `synapse_claim_and_brief` and
  closes inside `synapse_spawn_release` — the two calls a delegation *cannot skip*, because the briefing
  is only obtainable through the claim. Memory that relies on an agent remembering to write it is the
  same discipline problem that makes agents drift; this one cannot be forgotten without also failing to
  get a briefing. The episode opens at CLAIM time, so work that dies mid-flight still leaves a record —
  the case a later agent most needs.

- **Historical dedup.** `synapse_claim_and_brief` already refuses a job running *now* (the lease). It now
  also reports a job that already RAN, with its outcome and summary, as `priorRun`. It **warns rather
  than refuses**: re-running a triage next week is legitimate work; re-running it *unknowingly* is the
  waste worth naming.

### Changed
- `synapse_spawn_release` takes `summary`, `refs`, `outcome` and `episodeId`. Releasing without a
  summary returns a note saying so — a run recorded with no account of itself is nearly useless to the
  agent that finds it later.

### Notes
- Episodes are **primary data**, stored in `db/durable-spawn.db` beside the leases — never in
  `db/synapse.db`, which is a rebuildable embeddings cache any `--all` run may discard.
- Retrieval is **FTS5 keyword, not embeddings**. Episodes are short, recent, and full of exact tokens
  that matter — ticket ids, branch names, spec paths. Keyword finds `REL-38837`; cosine does not. It
  also works offline with no index to keep fresh. `searchEpisodes` is shaped so an embedding ranker can
  be fused in later.
- `synapse_log` is registered on the read-only `standard` surface deliberately: it records a fact about
  a run, authors no vault content, and needs no review gate. A doer restricted to `standard` must still
  be able to say what it did, or the memory has a hole exactly where the work happens.
- An empty result says the work was **not recorded**, not that it never happened — absence of a record
  is not evidence of absence.

## 0.11.0 — 2026-08-19

### Added
- **The embeddings index now says when it is out of date — and fixes itself.** A *missing* index has
  always been loud (`augment` prints a skip note); a *stale* one was completely silent. Recall went on
  ranking against the vault as it was weeks ago, with nothing in the output to say so. `augment` now
  checks freshness, refreshes incrementally when it is behind, and — when it cannot (offline Ollama,
  `SYNAPSE_NO_REFRESH`, a rebuild already running) — prints the warning **in the briefing itself**:

  ```
  > ⚠ semantic index is 42 note(s) behind the vault — run `synapse embeddings` (…).
  ```

- **`lib/index-freshness.mjs`** — the freshness engine, usable directly. `embeddingsStatus()` answers
  "is the index current, and by how many notes"; `refreshIfStale()` rebuilds only when it is not. Both
  are best-effort by contract: they never throw and never block the caller's real work.

- **`synapse embeddings-status`** — the same answer from the CLI. `--json` for machines, `--refresh` to
  act on it, `--fast` to skip the exact count. Named for the *embeddings* cache, deliberately distinct
  from `synapse index` (the SQL projections) — two different indexes that were easy to confuse.

- **A cooperative rebuild lock** (`db/.embed.lock`). `gen-embeddings` takes no lock of its own, so a
  fleet of standing agents sharing one vault could all notice staleness and all start rebuilding into
  one SQLite file. Now the first one in does the work and the rest carry on with the existing index. An
  expired lock (30 min) is broken, so a process that dies mid-rebuild cannot wedge the fleet.

- **`synapse setup` builds the index.** It used to provision Ollama and the model, print `✅ GO`, and
  leave `db/synapse.db` non-existent — so a fully "set up" vault still had semantic recall switched off.

### Changed
- **`synapse_embeddings_status` (MCP) reports freshness, not just presence.** It previously checked that
  a DB file existed and ran an offline math self-test, then said `verdict: healthy-or-ok` — which a
  two-month-old index passes. It now returns `staleCount`, `indexed`, `corpusNotes` and the model.
- **`synapse_embeddings_rebuild` (MCP) is detached and returns immediately.** It used to run in-band
  with a 600s timeout, freezing the calling agent's turn for the whole rebuild with no progress channel.
  It now starts the job and hands back a log path; poll `synapse_embeddings_status` until `stale=false`.

### Fixed
- **Id collisions no longer read as permanent staleness.** Note ids are basenames and are global, so
  when two files share one (`plans/alerts/step-01.md` and `plans/cases/step-01.md`) only the last one
  walked is embedded. Comparing every *file* against that single row reported notes as behind on an
  index built seconds earlier — and no rebuild could ever clear them, so the self-heal would fire on
  every call and accomplish nothing. Freshness now de-duplicates by id exactly the way `gen-embeddings`
  does. The collisions are still surfaced, as what they actually are: `⚠ 23 note(s) share an id with
  another and are NOT indexed`. Found against a live 2,616-note vault, where 13 ids shadowed 23 notes.
- **An embed-model change is detected.** No amount of mtime comparison can see it — the files are
  untouched, only the embedding space moved — so a model swap used to report "current" while every
  cosine in the index was meaningless. It is now checked before the time-based tiers.
- **Mtimes are compared in the form they are stored in.** Sub-millisecond precision survives in
  `mtimeMs` but not in the persisted ISO string, and the two do not round the same way, so comparing
  across the formats could flip the verdict on a sub-millisecond difference.
- **Vendored notes are no longer embedded into a consumer's index.** `gen-embeddings` walked
  `node_modules`, so this package's own example vault (`agents/`, `rules/`, `hub-synapse.md` — all
  shipped in `files[]`) was indexed into every consumer that installed it, and `agent-oracle` /
  `hub-finances` surfaced as semantic hits in unrelated vaults. `node_modules` and `db` are now hard-
  skipped by a walker (`lib/note-walk.mjs`) shared with the freshness check, so the two can never
  disagree about what the corpus is. The next `synapse embeddings` run prunes the stale rows.

### Notes
- Freshness compares each note against the **mtime stored in `note_vectors`**, not the DB *file's*
  mtime. The file-mtime approach needs a corrective `utimes` after every run — an incremental rebuild
  with nothing to do writes nothing, so the file's mtime never advances and "stale" stays true forever.
- A two-tier check keeps it cheap: a stat-only pass (~25ms on 2.5k notes) proves freshness in the common
  case; the exact per-note comparison (~400ms) runs only when that pass is inconclusive, and its verdict
  is cached in `db/.embed-check.json`. That second tier is what stops an untyped file (a `README.md`,
  which is never indexed) from reading as permanently stale.
- Disable the self-heal with `SYNAPSE_NO_REFRESH=1` — the warning still prints.

## 0.10.0 — 2026-08-14

### Added
- **`synapse_claim_and_brief` — the primary way to delegate, with no loss of harness features.** 0.9.0
  fused two separable things: *dedup* and *launching*. Because `synapse_spawn` owned the launch, taking
  the dedup guarantee also meant taking a **detached** process — which is invisible to the host CLI's
  task panel and sends no completion notification. Observed live: an orchestrator called `synapse_spawn`,
  could not see the doer in Cursor's Tasks panel, and killed + relaunched it as a native Task — throwing
  away the very guarantee it had just acquired.

  `synapse_claim_and_brief` unbundles them: it runs the **same enforced gate** (semantic pre-check →
  lease `acquire` → render) and returns the briefing plus `{spawnId, owner, token}` — then **you** launch
  with your own harness (Task tool, `@mention`, terminal). You keep the task panel, streaming and
  completion notification; dedup is still enforced, because the briefing is only obtainable *through*
  the claim, and a doer may never start without one. Release with `synapse_spawn_release`.

  The gate is shared, so a job claimed by either tool blocks the other — dedup holds across every
  delegation style, including `@mention`-based fleets that neither tool launches.

### Changed
- **`synapse_spawn` is now the specialist path**, not the default. Use it only when the work must
  outlive your session/turn, or when there is no harness to launch with (cron, a script, a headless
  run) — it is the only path that accepts losing task-panel visibility in exchange for durability.
  `synapse_spawn_status` now reports `via: "harness-native (yours)" | "detached (synapse)"` so the
  caller knows which liveness channel applies (harness notification vs status-file heartbeats).

## 0.9.1 — 2026-08-13

### Fixed
- **durable-spawn lint no longer false-positives on ordinary prose.** The `file-time-decides-liveness`
  check flagged any line where a time word sat near a liveness word — so a Zephyr test-case row like
  "stale case + dead selector" tripped it (`stale` near `dead`), with no file or transcript in sight.
  Split time words into **concrete file-timestamps** (`mtime`, `last-modified`, `timestamp`, …) vs
  **soft staleness** (`stale`, `last-updated`): soft words now only signal the anti-pattern when
  anchored to a transcript/output file; a concrete file-time word still trips on its own near a
  liveness word. Every genuine incident phrasing is still caught (8 lint tests).

## 0.9.0 — 2026-08-13

### Added
- **`synapse_spawn` — durable, CLI-agnostic, dedup-safe agent delegation (new `orchestrator` MCP surface).**
  Until now an orchestrator agent (e.g. a QA lead) delegated by prompt convention — "don't double-dispatch"
  is advice a model can forget, and a restarted orchestrator can spawn a duplicate. That class of bug is
  now impossible in code.
  - **`orchestrator` surface** = `full` + the spawn tools. It is the ONLY surface where a tool starts work
    rather than returning text; read-only agents on `standard`/`full` never see it.
  - **`synapse_spawn`** renders `<agent>`'s briefing and launches it as a **detached background doer** via
    `--cli` (cursor / claude / opencode), so the doer outlives the tool call. Dedup is guaranteed by a
    SQLite **lease** keyed on a **canonical `job` id the caller supplies from stable facts**
    (`agent:TICKET:suite:branch`) — a live job is refused atomically (`BEGIN IMMEDIATE`, one row per job).
    A **semantic "same task?" pre-check** (local Ollama embeddings) catches a differently-worded duplicate
    before the lease and **fails open** when Ollama is down (the lease stays the hard guarantee).
  - **`synapse_spawn_status` / `_list` / `_renew` / `_release`** — liveness via lease + status-file
    heartbeats (`hang-suspected → escalate-human`, never auto-kill), restart reconciliation via `staleSpawns`.
  - **`synapse spawn-emit`** — the sqlite-free doer command to report `HEARTBEAT/WAITING/DONE/FAILED`.
  - **`lib/durable-spawn/`** — the lease/registry/heartbeat/liveness primitives (ported, 37 tests), the
    enforced cure for the transcript-mtime-as-liveness incident. Its anti-pattern **lint is now wired into
    `synapse lint`**, so a briefing/rule that reinstates it fails CI.

## 0.8.0 — 2026-08-11

### Added
- **`addressable` agents — a created agent is now one an operator will actually run.** An agent note was only half of a standing agent: Cortex derives its run roster by scanning `agents/` for `addressable: true`, and nothing in Synapse could set that flag. `synapse new agent` and `synapse_create_agent` both produced notes that lint clean, render fine, and are **never started by anybody** — silent in both directions, with no warning at create time and no mention of the agent at start time.
  - `scaffold`: an `addressable` option, emitted as frontmatter for agent notes only. Opt-in, so a persona note used purely for rendering stays the default.
  - CLI: `synapse new agent <id> --addressable`.
  - MCP: `addressable` on `synapse_create_agent`. Because creating the note is only step 1 of 4, the success message now spells out the operator steps that remain (start → attest → sync-mcp-auth), **each of which fails silently when skipped** — an unattested agent replies normally while its activity stays invisible to clients.

Install: `npm install @eborja/synapse@^0.8.0`

## 0.7.4 — 2026-08-04

### Fixed
- **Orchestrators no longer claim a specialist's work.** `rule-agent-orchestration`: "could I do this?" is the wrong test (a generalist can do almost anything) — "whose `purpose` owns it?" is right; a task inside a specialist's remit MUST be delegated even when you are capable of it. `agent-curator` now dispatches `agent-ingester` per inbox capture (mirroring reconciler per drifted unit) and is told plainly it does not do the doer's job.
- **Reply contract hardened** — publishing is unconditional and covers "nothing to do" / "out of my remit"; a silent delegate stalls the orchestration loop. **No fabricated delegations** — report only handoffs backed by a real `--mention` or Task result; on buzz-acp (no Task tool) a non-addressable best-fit is escalated to the human, never pretended.

Install: `npm install @eborja/synapse@^0.7.4`

## 0.7.3 — 2026-08-04

### Added
- **`rule-one-writer-per-worktree`** — a git working tree has one writer at a time. Check
  `git status --porcelain` before a checkout, branch, stash, or stage; if the tree holds changes you did
  not author, do not switch branches (a switch **relocates** every uncommitted change onto the new
  branch), never `git add -A`, and never revert or stash a foreign diff. Stage by explicit path, or
  report the contention. Notes that per-agent checkout isolation removes the hazard outright rather than
  relying on etiquette. Wired into `agent-curator`, `agent-reconciler`, `agent-ingester`.

Found live 2026-08-04: an orchestrator ran `git checkout -b` in a shared repo where another session held
an uncommitted edit. The edit silently moved onto the new branch, and the orchestrator then spent turn
budget investigating a diff it had not made. Quiet in both directions — git warns neither writer.

Install: `npm install @eborja/synapse@^0.7.3`

## 0.7.2 — 2026-08-03

### Fixed
- **`rule-buzz-reply-contract` no longer implies the relay URL is already in the environment.** It told
  an agent to source its per-agent env "for the key", while `buzz messages send` needs a key **and** a
  relay URL — and neither is guaranteed in the shell an agent's tools run in. An agent with no memory of
  a previous run would authenticate and still fail to publish, then *guess* a URL. The rule now says
  both credentials come from the provisioned env file, that a wrong relay URL surfaces as a
  **mention-preflight / exit-4** failure rather than an auth error (which misdirects the diagnosis), and
  that a relay URL must never be invented.

Found by running the choreography end to end: a freshly provisioned `reconciler` was mentioned, did the
work, and burned two `messages send` attempts before locating the relay config unaided.

Install: `npm install @eborja/synapse@^0.7.2`

## 0.7.1 — 2026-08-03

### Fixed
- **`synapse_list_agents` now reports each agent's `addressable` / `autonomous` capabilities.** It read
  the frontmatter but returned only `id`/`title`/`purpose`, so the flags added in 0.7.0 were invisible
  to callers. `rule-agent-orchestration` tells an orchestrator to pick its handoff channel from the
  target's `addressable` flag — via a registry that never emitted it, making the rule unsatisfiable: an
  orchestrator fell back to a silent subagent spawn even when the target held a chat identity. Caught by
  observing a live handoff. Each agent now renders as
  `- **reconciler** (\`agent-reconciler\`) [addressable, on-demand] — …`, and the tool explains how the
  capability picks the handoff channel.

Install: `npm install @eborja/synapse@^0.7.1`

## 0.7.0 — 2026-08-03

### Added
- **Two orthogonal agent capability flags** — `autonomous` (runs on its own clock) and `addressable`
  (holds a Buzz identity, can be `@mention`ed and replies in-thread). Both default to `false`. They
  replace the implicit, conflated notion of a "standing" agent, which forced an agent to be
  self-running in order to be watchable. Declared per agent, so **the package owns the roster** and a
  conforming harness reads the flags instead of a hand-maintained list of names.
- **`decision-0008-addressable-vs-autonomous`** — the ADR recording why the two properties split, and
  the contract a conforming harness implements (provision an identity for each `addressable` agent;
  schedule each `autonomous` one).

### Changed
- **`agent-reconciler` and `agent-ingester` are now `addressable: true` (and `autonomous: false`)** —
  dispatch-only doers that nonetheless hold a Buzz identity, so their handoffs are **observable** in a
  thread rather than hidden inside an orchestrator's `Task` spawn. `rule-buzz-reply-contract` is wired
  into both: summoned on Buzz → publish the report into that thread; spawned via `Task` → return it to
  the orchestrator. Their remit is unchanged — still propose-only, never the DB, never a PR.
- **`agent-oracle` and `agent-curator`** declare `autonomous: true, addressable: true` (their existing
  behaviour, now explicit).
- **`rule-agent-orchestration` picks the handoff channel from the target's `addressable` flag** —
  addressable → hand off **on Buzz** (`@mention` in-thread, then score its posted reply); otherwise
  spawn quietly via `Task`. Visibility is now a property of *who* you delegate to, so it generalises to
  any future agent.
- **`rule-buzz-reply-contract` keys on `addressable`, not on role** — the publish-every-turn obligation
  binds to holding a Buzz identity, explicitly including an addressable doer.

Delegation still moves work, not authorization: publishing to a thread never bypasses the human gate on
irreversible actions.

Install: `npm install @eborja/synapse@^0.7.0`

## 0.6.0 — 2026-08-03

### Added
- **`rule-buzz-reply-contract`** — a standing agent MUST publish its result every turn via the `buzz
  messages send` CLI (`--reply-to` threads the reply; `--mention` hands off to the next agent).
  `SendMessage` is agent-to-agent, **not** the Buzz channel reply. Wired into `agent-curator` and
  `agent-oracle`.
- **`rule-agent-orchestration`** — claim-or-delegate → score → re-delegate, one level deep. Wired into
  `agent-curator`.
- **Framework pattern notes** now ship: `note-synapse-harness-playbook` and `note-synapse-mcp-backlog`
  moved to their canonical home in the framework, and `notes/` is added to the package `files`.

These rules and notes were previously authored in a consuming vault by mistake; the framework is their
source of truth, and consumers pick them up on `npm install`.

Install: `npm install @eborja/synapse@^0.6.0`

## 0.5.0 — 2026-08-03

### Added
- **`body` on the `synapse_create_*` authoring tools (and `build()`)** — a note can now be created
  with its full Markdown body in one propose call instead of scaffold-then-edit. A supplied `body`
  replaces the per-type stub; the `## Related` hub/parent wiring is still appended unless the author
  writes their own. Backward compatible — omit `body` and you get the identical stub. Same human
  gate: proposes by default, writes only on `write: true`.

Install: `npm install @eborja/synapse@^0.5.0`

## 0.4.0 — 2026-07-31

### Added
- **MCP plugins are auto-discovered** from `<vault>/_meta/mcp-plugins/*.mjs`. Drop in a module
  exporting `register(server, ctx)` and it loads — no env var, no absolute paths, nothing to
  maintain per machine. Every vault and sub-vault carries its own tools. `SYNAPSE_MCP_PLUGINS`
  still adds paths for plugins living outside the vault.
- **`synapse init [dir] [--write]`** — scaffold a new vault from the notes this package now ships
  (the manifest, `_meta/conventions.md`, the four agents, all `rule-*`, the `tool-*`/`skill-*`
  notes, `hub-synapse`), plus the empty domain dirs and a `package.json`. Never overwrites, so it
  is safe to re-run to pick up newly shipped notes. Previously `npm i @eborja/synapse` gave you an
  engine with nothing to render.
- **The generic content layer ships in the package** — `_meta/`, `agents/`, `rules/`, `tools/`,
  `skills/`, `hub-synapse.md` added to `files`. `init` copies the framework's *own* notes rather
  than a duplicated `starter/` tree, so what consumers get is exactly what this repo lints.
- **`synapse mcp-config [--write]`** — generates `.mcp.json` (Claude Code) and `.cursor/mcp.json`
  for the vault you are standing in, pointing at the `synapse-mcp` bin npm installed *into that
  vault*. Idempotent, dry-run by default, `--client claude|cursor`, `--surface <name>`. Replaces
  hand-written configs that hardcoded one machine's paths and broke on every move.

Install: `npm install @eborja/synapse@^0.4.0`

## 0.3.0 — 2026-07-31

### Added
- **`synapse new <kind> <name>`** — scaffold correctly-wired notes: `hub`, `agent`, `note --type
  <type>`, `handover`. Dry-run by default, `--write` to create. Built on `lib/scaffold.mjs`, which
  reads `lib/schema.mjs`, so generated notes satisfy the schema the linter enforces.
- **`--used-by <agent-ids>`** — writes the **inbound** edge into each agent's frontmatter
  (`rule → applies_rules`, `tool → uses_tools`, `skill → invokes_skills`). This is what prevents
  orphans: a new rule is only reachable once an agent cites it, and that link lives in the agent's
  file, so creating the note alone leaves it valid but invisible to briefings.
- **`synapse_create_{hub,agent,note,handover}`** MCP tools (full surface), sharing the same core.
  They **propose by default** — path + rendered content + planned inbound edges — and write only
  when called with `write: true` ([[rule-synapse-human-gated-push]]). Running an agent on the
  `standard` surface leaves them unregistered, making "the read front door never mutates" a
  property of the surface rather than a prompt instruction.

### Fixed
- Scaffolding resolves the vault with `preferCwd`, so an exported `SYNAPSE_VAULT` pointing at
  another vault can no longer silently misdirect a write; the destination is echoed on every run.

Install: `npm install @eborja/synapse@^0.3.0`

## 0.2.0 — 2026-07-31

### Added
- **MCP server ships in the package.** `mcp/` + a second bin, `synapse-mcp` — the vault as MCP tools
  over stdio (13 built-ins across `skeleton` / `standard` / `full`). Previously this lived only in a
  private, unpublished vault package. `@modelcontextprotocol/sdk` + `zod` are now dependencies;
  `npm run smoke` drives the server against this repo.
- **`SYNAPSE_MCP_PLUGINS`** — consumer-specific MCP tools without forking. Comma-separated ESM paths,
  each exporting `register(server, ctx)` where
  `ctx = { server, surface, VAULT, runSynapse, asToolResult, manifest }` — the same helpers the
  built-in tool modules use. Plugins register after the built-ins and fail loudly if malformed.
- **`lib/schema.mjs`** (exported as `@eborja/synapse/schema`) — `PREFIX_TYPE`, `REQUIRED`,
  `typeForId()`, `requiredFields()`, `knownTypes()`, `rolesFromManifest()`, and `fieldForLink()`.
  The last resolves which frontmatter field a link belongs in from **both** endpoints (an `agent`
  cites a `tool` via `uses_tools`; a `note` cites the same tool via `related`), derived from the
  manifest `roles` block rather than hardcoded.

### Changed
- `lib/lint.mjs` imports `PREFIX_TYPE` / `REQUIRED` from `lib/schema.mjs` instead of declaring them,
  so the checker and the generators cannot drift. Lint output is byte-identical.
- **No longer dependency-free.** The MCP server needs `@modelcontextprotocol/sdk` and `zod`; the CLI
  and engine paths themselves still add nothing at runtime.

Install: `npm install @eborja/synapse@^0.2.0`

## 0.1.7 — 2026-07-15

### Added
- **`doc-npm-release`** — canonical checklist for shipping `@eborja/synapse` (CHANGELOG → pins → tag →
  human `npm publish` → **mandatory** vault bump). Linked from [[hub-synapse]], [[doc-fork-and-extend]],
  and `CONTRIBUTING.md`. Agents follow it whenever asked to publish; the vault pin is updated every
  release without a separate ask.

### Changed
- **Nested hub workspaces mirror the parent→child tree** — a working domain lives at
  `hub/<parent>/hub-<parent>.md` with children under it (e.g. `hub/career/courses/hub-courses.md`), not
  as a sibling `hub/courses/`. Flat `hub/hub-*.md` remains valid for map-only hubs. Docs and the
  career→courses reference example updated ([[decision-0007-composable-sub-hubs]]).

Install: `npm install @eborja/synapse@^0.1.7`

## 0.1.6 — 2026-07-15

### Added
- **Sub-hub workspace directories** — a working sub-hub lives at `hub/<slug>/hub-<slug>.md` (e.g.
  `hub/courses/`); that directory is the workspace for typed members and non-note helpers. Flat
  `hub/hub-*.md` remains valid for map-only hubs. `synapse hubs` / Tab completion discover both via a
  recursive scan under `hub/`.

Install: `npm install @eborja/synapse@^0.1.6`

## 0.1.5 — 2026-07-15

### Fixed
- **Pre-commit lint gate** — always sets `SYNAPSE_VAULT` to the repo being committed, so an ambient
  `$SYNAPSE_VAULT` pointing at a private consumer vault no longer redirects the strict lint and falsely
  blocks framework commits.
- **zsh Tab completion after an agent name** (hub targets, `--model`, `--cli`, `--profile`) silently
  fell back to filename completion. zsh does not word-split unquoted parameters, so
  `compdef __mx_complete_zsh ${_MX_AGENT_NAMES} …` registered the whole name list as one bogus
  command and never bound the per-agent widget. Now split explicitly with `${=_MX_AGENT_NAMES}`.
- **`--model` completion ignored a preceding `--cli <x>`** in zsh (always listed the default runtime's
  models). `__mx_cli_from_words` iterated a single joined scalar; it now iterates its args word-by-word
  and both call sites pass words individually (`${(@)words[2,-1]}` / `"${COMP_WORDS[@]}"`). bash was
  unaffected.

### Added
- **Composable sub-hubs** — a `hub` can nest under a parent hub (and hold its own sub-hubs). A sub-hub
  **declares its parent** in `related` (child-declares-parent, like a member declares its hub); the
  `NAVIGATES` role is now **bidirectional** so that one edge renders both ways — a parent shows each
  sub-hub's map at `standard` but not its members until `fat`. No new type, field, or role. Documented in
  `_meta/decisions/decision-0007-composable-sub-hubs.md` and `_meta/conventions.md`; reference example:
  `hub-career` → `hub-courses` → course notes.
- **Hub-tree Tab completion** — `<agent> hub-parent/<TAB>` drills one level down into that hub's sub-hubs
  (e.g. `curator hub-career/` → `hub-career/hub-courses`), chainable for deeper nesting; the leaf segment
  is the real render target. zsh + bash.

Install: `npm install @eborja/synapse@^0.1.5`

## 0.1.4 — 2026-07-14

### Changed
- **Shell status banners** — `agents.sh` prints emoji-tagged steps on launch and discovery
  (`⏳` building · `🚀` launching · `📋` clipboard · `🔍` semantic · per-agent icons), so it's clearer
  what's happening without reading the full line. See `docs/doc-cli-reference.md`.
- **Tab completion for agents & hubs** — zsh/bash complete agent short names (top-level and
  `synapse <agent>`), hub targets after any agent, and `agent-*`/`hub-*` ids for
  `synapse render|augment`. Vault is re-resolved on every Tab (`$PWD` walk + `$SYNAPSE_VAULT`),
  so completion works from any cwd. Core agents (`curator`/`oracle`/`reconciler`/`ingester`) are
  always registered even if no vault is found at source time.

Install: `npm install @eborja/synapse@^0.1.4`

## 0.1.3 — 2026-07-13

### Removed
- **Legacy `_meta/tools/*.mjs` engine shims** in the reference vault — the engine ships only via
  `@eborja/synapse` (`synapse <cmd>` or `node bin/synapse.mjs` during package development). Vaults keep
  `_meta/tools/context.manifest.json` only; delete any duplicated engine scripts after `npm install`.

### Changed
- **`synapse install`** now writes a `~/.claude/CLAUDE.md` pointer that references `synapse render`, not
  a shim path.
- **Pre-commit hook and nightly cron** resolve the engine via `synapse` on PATH or `bin/synapse.mjs`.

Install: `npm install @eborja/synapse@^0.1.3`

## 0.1.2 — 2026-07-12

### Fixed
- **Agent launchers (`oracle` / `curator` / …) no longer fail with `command not found: synapse`** after
  `synapse install --write`. The sourced `synapse()` shell function was making `command -v synapse`
  succeed even when no binary was on `PATH`, so engine calls tried `command synapse` and died. Engine
  subcommands now resolve via the PATH binary when present, otherwise `node` + package `lib/*.mjs`.
- **`synapse install` prefers the vault of `$PWD`** over a stale `$SYNAPSE_VAULT` from a previous
  install, so re-running `--write` from your private vault rewrites the shell rc to the correct root.

Install: `npm install @eborja/synapse@^0.1.2`

## 0.1.1 — 2026-07-11

### Fixed
- First public publish under `@eborja/synapse`. Version `0.1.0` was reserved on the registry during an
  auth-retry (npm forbids republishing a used version even when the package page 404s), so the release
  ships as **0.1.1**.

Published on npm: [`@eborja/synapse@0.1.1`](https://www.npmjs.com/package/@eborja/synapse).

Install: `npm install @eborja/synapse@^0.1.1`

## 0.1.0 — 2026-07-11

Initial distributable release of the context-vault engine as an npm package. The tooling that previously lived only under `_meta/tools/` in the template now ships as `@eborja/synapse` — consumers keep their vault content and a local `context.manifest.json`; the engine resolves the vault via `$SYNAPSE_VAULT` or an ancestor walk.

> **Scope note:** published as `@eborja/synapse` (npm user scope). GitHub org/user remains `eborjaa`.

### Added

- **Docs** — README / CONTRIBUTING / AGENTS / TUTORIAL / fork-and-extend / CLI reference updated for the npm package consumption model (`synapse <sub>` as the front door).
- **`hub` type** — domain maps formerly called `moc` (Map of Content). Ids are `hub-<domain>`; list with `synapse hubs`.
- **`bin/synapse`** dispatcher — `render`, `augment`, `lint`, `embeddings`, `index`, `views`, `migrate`, `setup`, `install`, `journal`. Shell subcommands (`agents`, `hubs`, `profiles`, `models`, `bedrock`, `reload`, `gate`) live in the sourced `agents.sh` wrapper (same `synapse <sub>` namespace; `vault-*` names are maintained equals).
- **`vault-root` resolver** — `$SYNAPSE_VAULT` → ancestor walk; auto-detects nested (`context-vault/_meta/tools/`) and flat (`_meta/tools/`) layouts.
- **`setup`** — probe/provision Ollama + the embedding model (TTY opt-in; `--write` auto-accepts; never sudos).
- **Data-driven session-health trailers** (`trailers.mjs`) — canary + handover, controllable via the consumer manifest.
- **SQL records tooling** in-package — `migrate` / `index` / `views` for the personal-knowledge records substrate (SQL-canonical rows surfaced as generated Markdown views).
- **`schema/context.manifest.example.json`** — copy into your vault's `_meta/tools/`.
- **`agents.sh`** ships in the package and is sourced from its installed location.

### Compatibility

- **`engines.node`: `>=22`** (built-in `node:sqlite`). Runtime deps as of 0.2.0:
  `@modelcontextprotocol/sdk` + `zod`, required by the `synapse-mcp` server only.
- Existing flat vaults (this template) keep working: put (or keep) `context.manifest.json` under `_meta/tools/` and run from the vault root.

### Upgrading

```jsonc
"@eborja/synapse": "^1.1.1"
// or: "github:eborjaa/synapse#v1.1.1"
```

```sh
npm install
npx synapse install --write
exec $SHELL
```

Replace `node _meta/tools/<tool>.mjs …` with `synapse <cmd> …` (or `npx synapse <cmd> …`). Keep your vault notes; delete duplicated engine scripts from `_meta/tools/` once you depend on the package — leave only `context.manifest.json`.