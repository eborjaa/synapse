# Changelog

All notable changes to `@eborja/synapse` are documented here. Follows [Keep a Changelog](https://keepachangelog.com/) + [SemVer](https://semver.org/).

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
"@eborja/synapse": "^0.1.3"
// or: "github:eborjaa/synapse#v0.1.3"
```

```sh
npm install
npx synapse install --write
exec $SHELL
```

Replace `node _meta/tools/<tool>.mjs …` with `synapse <cmd> …` (or `npx synapse <cmd> …`). Keep your vault notes; delete duplicated engine scripts from `_meta/tools/` once you depend on the package — leave only `context.manifest.json`.