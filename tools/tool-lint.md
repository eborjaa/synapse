---
id: tool-lint
type: tool
title: lint.mjs — the mechanical vault health-check
tags:
  - type/tool
  - area/meta
  - status/active
---

# tool-lint (`synapse lint`)

The **mechanical health-check**. It *detects* schema problems; an agent *heals* them. A "vault artifact"
is any `.md` with a `type:` field; files without frontmatter are ignored.

## What it is
A manifest-driven linter (Node, read-only). It enforces the schema described in [[conventions]] across
three severity tiers:

- **ERROR (always fails):** missing `id`/`type`/`title`/`tags`, filename-prefix vs `type:` mismatch, a
  missing `#type/<type>` tag, a broken `migration:` path on disk, inline secrets, or a note in a
  generated-view directory missing `generated: true`.
- **WARNING (fails only under `--strict`):** broken or unresolved wikilinks, unbalanced code fences.
- **ADVISORY (never fails):** orphans (no inbound links), oversize notes (>600 tokens ≈ split candidate).

## How it is used in Synapse
The curator runs `lint.mjs --strict` as its first drift signal each pass of [[loop-maintain-synapse]];
`errors=0` is part of the loop's dry-gate exit condition. Authors run it before committing.

```sh
synapse lint            # report; exit 1 only on ERROR
synapse lint --strict   # also fail on WARNINGs (broken links, fences)
```

Notes under `_meta/` are excluded from the broken-link check, so illustrative placeholder links there are
safe. The secret scanner catches keys/tokens/passwords but **not** amounts or account numbers — record
privacy rests on the private repo and the read-only query credential, not the linter.

## Related
[[conventions]] · [[tool-render]] · [[rule-derived-views-are-generated]]
