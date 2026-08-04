# Changelog

All notable changes to `@eborja/synapse` are documented here. Follows [Keep a Changelog](https://keepachangelog.com/) + [SemVer](https://semver.org/).

## Unreleased

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
"@eborja/synapse": "^0.5.0"
// or: "github:eborjaa/synapse#v0.5.0"
```

```sh
npm install
npx synapse install --write
exec $SHELL
```

Replace `node _meta/tools/<tool>.mjs …` with `synapse <cmd> …` (or `npx synapse <cmd> …`). Keep your vault notes; delete duplicated engine scripts from `_meta/tools/` once you depend on the package — leave only `context.manifest.json`.