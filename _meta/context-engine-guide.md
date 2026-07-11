---
id: context-engine-guide
type: doc
title: How the context engine works — manifest, roles, profiles, briefings
tags:
  - type/doc
  - area/meta
  - status/active
references_docs: ["[[conventions]]"]
related: ["[[hub-synapse]]"]
---

# How the context engine works

A plain-language tour of the briefing engine in **`@eborjaa/synapse`**: how `synapse render` reads your
vault's `context.manifest.json`, the three profiles, and how a deterministic briefing is assembled. The
companion to [[conventions]] (the schema) and [[tool-render]] (the command). Examples here are illustrative
— this note lives under `_meta/`, which the linter excludes from link checks.

## One manifest, no hardcoding
The engine hardcodes nothing domain-specific. Roles, fields, directions, endpoint types, profiles,
token budgets, excerpting, auto-upgrade, drop-tags, type priority, and invariants **all** come from
`_meta/tools/context.manifest.json` (copy `schema/context.manifest.example.json` from the package). The
same engine runs any vault's manifest unchanged.

## Roles → fields → directions → endpointTypes
A note's frontmatter fields are *edges*. The manifest maps each field to a **role** with a traversal
**direction**, and (for `related`) an **endpointTypes** filter that decides which target types a role
actually reaches. This is why a link only lands in a briefing if it sits in the field whose role
traverses to that target's `type:` ([[rule-synapse-edges-by-role]]):

| Role | Field(s) | Direction | Reaches `type:` |
|---|---|---|---|
| CONSTRAINS | `applies_rules` | forward | `rule` |
| USES | `invokes_skills`, `uses_tools` | forward | `skill`, `tool` |
| DELEGATES | `delegates_to` | forward | `agent` |
| BINDS (reverse name `members`) | `related` | reverse | `note` `journal` `project` `plan` `contact` `account` `summary` |
| ATTACHES | `related` | both | `person` `decision` `tool` `glossary` |
| NAVIGATES | `related` | forward | `hub` |
| REFERENCES | `references_docs` | forward | `doc` |

BINDS and ATTACHES share the `related` field but are **disjoint by endpoint type**: a target type is
either a member that rolls up under a hub (BINDS, surfaced in reverse as `members`) or a bidirectional
attachment (ATTACHES) — never both.

## The three profiles and their token budgets
A profile selects which **roles** to include (and optional `pointerRoles` / per-role `depth`). Token budgets
are guideline ceilings (`chars / 4`); `excerptChars` truncates non-mandatory bodies under the dial:

- **lean** (~4000 tokens) — CONSTRAINS, USES, DELEGATES (delegates often as one-line pointers). At lean,
  notes tagged `status/draft` are dropped (`dropTagsAtLean`).
- **standard** (~15000) — adds BINDS (members), ATTACHES, NAVIGATES (depth 1), REFERENCES. The default
  working briefing for a hub.
- **fat** (~30000) — same roles with high depth / transitive closure for deep dives.

## agent × target × profile → a deterministic briefing
`synapse render <agent> <target> --profile <p>` walks the role closure from those start ids and concatenates
the linked note **bodies** into one blob. Ordering is fixed — start ids first (in the order given), then
the manifest's `typePriority`, tie-broken by name — so identical (ids + flags) produce **byte-identical**
output. That determinism is what makes agent runs reproducible.

```sh
synapse render agent-curator loop-maintain-synapse --profile standard
```

## Auto-upgrade
`autoUpgrade` bumps the profile when a start id's type warrants more context. Here `{ "hub": "standard" }`
means rendering a `hub` at lean auto-upgrades to standard (idempotent) — a hub is useless without its
members.

## How `synapse lint` / `synapse render --lint` enforce the schema
`synapse render --lint` checks the manifest's `invariants` over the whole index — e.g. every non-master `hub`
at `standard` must have `members>=1` and stay within `3*median` tokens (thresholds may be literals or
cohort statistics like `median`/`p90`, so budgets self-scale as the vault grows). Separately,
[[tool-lint]] (`synapse lint`) enforces the per-note schema — frontmatter completeness, prefix↔type match, the
`#type/<type>` tag, balanced fences, no secrets — so the engine can trust every note it traverses.

## Complemented by semantic recall (opt-in, separate)
The role-closure engine is **deterministic by design** — it follows only typed links, so the briefing is
reproducible and reviewable. That precision is also its limit: it reaches nothing you didn't explicitly
link. An **opt-in second phase**, `augment.mjs` ([[doc-semantic-recall]]), closes that gap *without
touching this engine*: it shells `render.mjs` for the deterministic seed, then appends embedding-similar
notes (from local Ollama, [[tool-ollama-embeddings]]) under a clearly-labeled "semantically related"
heading. The augment is additive and non-authoritative ([[rule-semantic-suggests-links-decide]]) — so
`render.mjs` stays pure, offline, and byte-identical; hybrid retrieval lives entirely in the separate tool.

## Related
[[conventions]] · [[tool-render]] · [[tool-lint]] · [[rule-synapse-edges-by-role]] · [[doc-semantic-recall]] · [[tool-ollama-embeddings]] · [[hub-synapse]]
