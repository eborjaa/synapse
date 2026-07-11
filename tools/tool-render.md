---
id: tool-render
type: tool
title: render.mjs — the manifest-driven briefing engine
tags:
  - type/tool
  - area/meta
  - status/active
---

# tool-render (`synapse render`)

The **briefing engine**. Given one or more note ids, it walks the ontology defined in
`_meta/tools/context.manifest.json` and concatenates the linked note bodies into a single context blob —
exactly the rules, skills, tools, docs, and neighborhood an agent needs, and nothing else.

## What it is
A small Node script (stdin/stdout only — it never writes or edits a `.md`). Nothing domain-specific is
hardcoded: roles, fields, directions, endpoint types, profiles, auto-upgrade, drop-tags, type priority,
and invariants all come from the manifest, so the same engine runs any vault unchanged
([[context-engine-guide]]).

## How it is used in Synapse
A briefing is compiled deterministically as `agent × target × profile` — identical inputs produce
byte-identical output, which is what makes agent runs reproducible:

```sh
synapse render agent-curator loop-maintain-synapse --profile standard
```

- `--profile lean|standard|fat` picks how wide the closure goes (token budgets in the manifest).
- `--dry-run` lists the closure without emitting bodies; `--copy` puts the blob on the clipboard.
- `--lint` validates the manifest invariants over the whole index (e.g. every non-master `hub` has at
  least one member at `standard`).

Every agent's `uses_tools` lists this note; the curator seeds each reconciler with a `render.mjs` command.

## Related
[[context-engine-guide]] · [[conventions]] · [[tool-lint]]
