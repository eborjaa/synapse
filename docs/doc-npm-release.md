---
id: doc-npm-release
type: doc
title: Publishing @eborja/synapse — release checklist
tags:
  - type/doc
  - area/meta
  - status/active
references_docs: ["[[doc-fork-and-extend]]", "[[doc-cli-reference]]"]
related: ["[[hub-synapse]]", "[[rule-framework-docs-current]]"]
---

# Publishing `@eborja/synapse`

How a framework change becomes a version on the npm registry, then lands in a consumer vault.
**Agents: follow this note whenever the human asks to publish, bump, or ship the package.** Do not
improvise a shorter path.

## Roles

| Who | Does |
|---|---|
| **Agent** | Feature PR → merge → CHANGELOG promote → pin bumps → `chore(pkg)` commit → `vX.Y.Z` tag → push → vault bump (if asked). Docs in the same change ([[rule-framework-docs-current]]). |
| **Human** | Reviews/merges the feature PR; runs `npm login` / `npm publish` (credentials stay with the human). |

When the human says "push to npm" / "publish the package", the agent finishes everything *except*
`npm publish`, then **outputs only the publish commands** for the human to run.

## Preconditions

1. Feature work is on `main` via a **merged PR** (not an open feature branch). Release bumps may land as a
   direct `chore(pkg)` commit on `main` after that merge (maintainer admin-bypass is fine for the bump).
2. Pre-commit lint always targets **this repo** (`SYNAPSE_VAULT` pinned to the git toplevel in
   `_meta/tools/pre-commit.sh`). An ambient `$SYNAPSE_VAULT` pointing at a private vault must not redirect
   the gate.
3. `synapse lint --strict` is clean against the framework root.
4. Next SemVer is clear: patch for fixes/docs/CLI polish; minor for user-visible engine features. Never
   reuse a published version (npm forbids republish).

## Framework release (checklist)

Work in the **framework** repo (`synapse-framework` / `eborjaa/synapse`), on `main`, after the feature PR
merged.

### 1. Sync

```bash
cd /path/to/synapse-framework
git checkout main && git pull origin main
```

### 2. Promote CHANGELOG

Move the current `## Unreleased` body to a new section (keep an empty `## Unreleased` on top):

```md
## Unreleased

## X.Y.Z — YYYY-MM-DD
### Added / Fixed / Changed
- …

Install: `npm install @eborja/synapse@^X.Y.Z`
```

Leave historical sections' Install lines alone (e.g. `## 0.1.5` keeps `^0.1.5`).

### 3. Bump package + install pins

```bash
# package.json "version"
npm version X.Y.Z --no-git-tag-version   # or edit by hand
```

Update consumer-facing pins from the previous version → `^X.Y.Z` / `vX.Y.Z` in at least:

- `README.md`
- `docs/doc-fork-and-extend.md`
- `docs/doc-roadmap.md` (install example)
- `CHANGELOG.md` upgrading snippet at the bottom (living "how to upgrade" block)

**Careful with `@` in shell one-liners** — unquoted `@eborja` can be eaten by the shell. Prefer a small
editor/`node` script, or quote carefully.

### 4. Commit, tag, push

```bash
git add package.json package-lock.json CHANGELOG.md README.md docs/
git commit -m "chore(pkg): bump to X.Y.Z for npm publish"
git tag vX.Y.Z
git push origin main --tags
```

### 5. Human publishes (agent stops here and prints these)

```bash
cd /path/to/synapse-framework
npm login                         # if needed
npm publish --access public
npm view @eborja/synapse version  # expect X.Y.Z
```

## Vault bump (after the version is on npm)

In the **private vault** (`synapse-vault`), only the engine pin + any vault content that depends on the
new behavior. Do **not** sweep unrelated dirty health/migration files into the same commit.

```bash
cd /path/to/synapse-vault

# Drop a local npm link if present
npm unlink @eborja/synapse 2>/dev/null || true
npm install @eborja/synapse@^X.Y.Z
npx synapse install --write

# Stage only the bump (+ intentional content). Example:
git add package.json package-lock.json README.md   # + manifest/hubs/notes if part of the same ship
git commit -m "chore: bump @eborja/synapse to ^X.Y.Z"
git push origin main

# Interactive shell must re-source agents.sh
synapse reload   # or: exec $SHELL
```

If the vault was `npm link`'d to the framework for local testing, unlink **after** publish so Tab
completion and `agents.sh` come from the registry tarball, not a dirty tree.

## Agent anti-patterns

- Do **not** ask the human to re-explain this flow — open [[doc-npm-release]] and execute it.
- Do **not** run `npm publish` yourself unless the human explicitly hands you credentials/session and asks
  you to run it.
- Do **not** publish from a feature branch; publish from tagged `main` that matches the tarball.
- Do **not** leave `## Unreleased` holding the shipped notes, or bump pins without the CHANGELOG section.
- Do **not** commit the private vault's unrelated dirty tree with the bump.

## Related
[[doc-fork-and-extend]] · [[rule-framework-docs-current]] · [[doc-cli-reference]] · [[hub-synapse]]
