---
id: doc-fork-and-extend
type: doc
title: Fork and extend — engine package vs. your vault
tags:
  - type/doc
  - area/meta
  - status/active
references_docs: ["[[conventions]]"]
related: ["[[hub-synapse]]"]
---

# Fork and extend

Synapse is a **framework**, not a finished vault. The maintainable unit is the **tooling npm package**;
your knowledge and records stay in a private vault that *consumes* the package.

## Two layers

- **The engine (`@eborja/synapse`).** Published on npm from this repo's `bin/`, `lib/`, `agents.sh`, and
  `schema/`. Manifest-driven render / augment / lint / embeddings / SQL helpers / install. **No personal
  data.** Install: `npm install @eborja/synapse@^0.1.1` (or pin a git tag: `github:eborjaa/synapse#v0.1.1`).
- **Your vault (a private repo).** Agents, rules, hubs, notes, `migrations/0002+`, `db/`. Depends on the
  engine via `package.json`. Its **`origin` is private**. Optionally track this repo as `upstream` if you
  also want the reference ontology notes — or keep only the npm dependency.

```sh
# Engine only (recommended for new vaults):
npm install @eborja/synapse@^0.1.1
npx synapse install --write

# Or pull framework *content* updates (agents/docs/rules) the old way:
git remote add upstream https://github.com/eborjaa/synapse.git
git fetch upstream && git merge upstream/main
```

**Never push your vault to `upstream`.** Contribute engine fixes back through a PR from a clean,
data-free branch.

## The boundary

| Engine package (`files` in package.json) | Yours (vault instance) |
|---|---|
| `bin/synapse`, `lib/*`, `agents.sh`, `schema/context.manifest.example.json` | `inbox/`, `notes/`, `journal/`, `projects/`, `plans/`, `people/`, your `db/`, domain hubs, `0002+` migrations, custom rules/agents |
| — | `_meta/tools/context.manifest.json` (your ontology dial — copy from `schema/`) |

Framework *content* in this template (`agents/`, `docs/`, `rules/`, …) is a **reference vault** you can
copy or track via git; it is **not** what `npm install` puts in `node_modules`.

## Vault layouts the engine understands

- **Flat** — `_meta/tools/context.manifest.json` at the vault root (this template).
- **Nested** — `context-vault/_meta/tools/context.manifest.json` under a package/repo root.

Resolution: `$SYNAPSE_VAULT` → ancestor walk from `$PWD` ([[tool-render]], `lib/vault-root.mjs`).

## Why it's safe

Knowledge is Markdown-in-git, records ride migration files, and every change is a reviewable diff
([[doc-governance-model]]). Updating the engine is an npm bump — it cannot overwrite your notes.

## Related
[[conventions]] · [[doc-storage-model]] · [[doc-governance-model]] · [[doc-repo-layout]] · [[doc-cli-reference]] · [[hub-synapse]]
