# Changelog

All notable changes to `@eborja/synapse` are documented here. Follows [Keep a Changelog](https://keepachangelog.com/) + [SemVer](https://semver.org/).

## Unreleased

### Added
- **`doc-npm-release`** — canonical checklist for shipping `@eborja/synapse` (CHANGELOG → pins → tag →
  human `npm publish` → vault bump). Linked from [[hub-synapse]], [[doc-fork-and-extend]], and
  `CONTRIBUTING.md`. Agents follow it whenever asked to publish.

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

- **`engines.node`: `>=22`** (built-in `node:sqlite`). Zero runtime dependencies.
- Existing flat vaults (this template) keep working: put (or keep) `context.manifest.json` under `_meta/tools/` and run from the vault root.

### Upgrading

```jsonc
"@eborja/synapse": "^0.1.6"
// or: "github:eborjaa/synapse#v0.1.6"
```

```sh
npm install
npx synapse install --write
exec $SHELL
```

Replace `node _meta/tools/<tool>.mjs …` with `synapse <cmd> …` (or `npx synapse <cmd> …`). Keep your vault notes; delete duplicated engine scripts from `_meta/tools/` once you depend on the package — leave only `context.manifest.json`.