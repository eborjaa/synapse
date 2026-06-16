# Contributing to Synapse

Synapse is a **framework** — a manifest-driven, local-first personal-knowledge-vault pattern. Contributions
improve the *framework* (engine, conventions, rules, agents, docs), never anyone's data. Thanks for helping.

## The lint gate (the bar for every PR)

Every PR must be lint-clean:

```bash
node _meta/tools/lint.mjs --strict   # must report errors=0
```

`--strict` also fails on broken wikilinks and unbalanced code fences. An optional pre-commit hook enforces
it locally:

```bash
ln -sf ../../_meta/tools/pre-commit.sh .git/hooks/pre-commit
```

## Conventions (see `_meta/conventions.md`)

Vault notes are typed Markdown and must follow the schema:

- **Frontmatter** on every note: `id`, `type`, `title`, `tags` — with a `type/<type>` tag matching `type:`.
  Agents also carry `purpose` and `invokes_skills`.
- **Block-style tags** — a YAML list, one `- type/<type>` per line (not inline `[a, b]`).
- **Bare wikilinks** — `[[basename]]` only; no path-qualified links. Put each link in the field whose role
  the manifest traverses (`applies_rules`, `references_docs`, `related`, …).
- **Balanced code fences** — every triple-backtick fence opens and closes.
- **Keep it generic** — no personal data, no instance-specific content, no internal paths, no private
  project references. The framework is data- and model-agnostic.

(`LICENSE`, `CONTRIBUTING.md`, `CREDITS.md`, `README.md`, and `.github/` files have no frontmatter and are
ignored by the linter — just keep their fences balanced.)

## Framework vs. instance boundary

The split is by directory (see [`docs/doc-fork-and-extend.md`](docs/doc-fork-and-extend.md)):

- **Framework (contributable here):** `_meta/` (engine, manifest, tools, rules), `agents/`, `loops/`,
  `docs/`, `rules/`, `skills/`, `tools/`, `migrations/0001-init-schema.sql`.
- **Instance (yours, never in a framework PR):** `inbox/`, `notes/`, `journal/`, `projects/`, `plans/`,
  `people/`, your `db/`, your domain MOCs, your `0002+` migrations, custom rules.

Your private vault tracks this repo as `upstream`. Contribute framework fixes via a PR from a clean,
data-free branch — **never push your vault to `upstream`**.

## Maker ≠ checker

Synapse's governance ethos: the actor that writes a change never approves it. Open a PR; a human reviews
and merges. Agents propose; humans gate. The same applies to contributions — review is required.

## Branch protection (how `main` is governed)

`main` is protected by a GitHub ruleset. In practice this means:

- **No direct pushes to `main`.** All changes land through a pull request.
- **Maintainer review is mandatory.** Every PR requires approval from a code owner (see
  [`.github/CODEOWNERS`](.github/CODEOWNERS)) before it can merge. As an outside contributor you cannot
  self-merge.
- **`main` cannot be deleted, and force-pushes are blocked.** History is append-only.
- **Stale approvals are dismissed** when new commits are pushed to a PR, so the approved diff is the
  merged diff.

Because this is a personal (non-org) public repo, outside contributors don't have push access at all —
**fork the repo, push to your fork, and open a PR from there.** The maintainer reviews, and merges.

## PR flow

1. Fork (or branch off `main`) from a clean, data-free state.
2. Make the change; keep it generic and scoped.
3. `node _meta/tools/lint.mjs --strict` → errors=0.
4. If you touched the schema, add a forward-only migration (never edit `0001-init-schema.sql` destructively).
5. Open a PR using the checklist in the PR template. Update docs if behavior changed.
