# Changelog

All notable changes to `@eborja/synapse` are documented here. Follows [Keep a Changelog](https://keepachangelog.com/) + [SemVer](https://semver.org/).

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
"@eborja/synapse": "^0.1.0"
// or: "github:eborjaa/synapse#v0.1.0"
```

```sh
npm install
npx synapse install --write
exec $SHELL
```

Replace `node _meta/tools/<tool>.mjs …` with `synapse <cmd> …` (or `npx synapse <cmd> …`). Keep your vault notes; delete duplicated engine scripts from `_meta/tools/` once you depend on the package — leave only `context.manifest.json`.
