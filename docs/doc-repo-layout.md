---
id: doc-repo-layout
type: doc
title: Repository layout — where each kind of note and tool lives
tags:
  - type/doc
  - area/architecture
  - status/active
references_docs: ["[[conventions]]"]
related: ["[[moc-synapse]]"]
---

# Repository layout

The vault root is the git repo root. Type-prefixed notes live in type-named directories; the engine and
linter discover everything by frontmatter, so layout is for humans (and Obsidian), not the renderer.

```text
synapse/
├── moc-synapse.md                 # master hub (entry point)
├── _meta/
│   ├── conventions.md           # the schema layer
│   ├── capture-philosophy.md    # how to think about capture / knowledge
│   ├── decomposition-recipe.md  # the ingester's atomization recipe
│   ├── context-engine-guide.md  # how render.mjs reads the manifest
│   ├── decisions/               # ADRs (decision-NNNN-*)
│   └── tools/                   # render.mjs · lint.mjs · context.manifest.json · harness · generators
├── docs/                        # architecture spec notes (doc-*)
├── agents/                      # agent-curator · agent-reconciler · agent-ingester
├── rules/                       # rule-synapse-* · rule-derived-views-are-generated · constitutional rules
├── skills/                      # skill-* pointer notes → .claude/skills/<name>/SKILL.md
├── loops/                       # loop-maintain-synapse
├── moc/                         # moc-finances · moc-contacts · moc-health · moc-places · moc-<project>
├── notes/ journal/ projects/ plans/ people/        # hand-authored knowledge (Markdown canonical)
├── contacts/ accounts/ finances/ health/ places/   # GENERATED derived views (DB canonical)
├── tools/                       # tool-* reference notes
├── migrations/                  # NNNN-*.sql + change-request notes (the SQL write gate + audit log)
├── db/                          # synapse.db (gitignored — derived, sensitive, binary)
└── inbox/
    ├── attention/               # escalations awaiting a human decision (Options + stop)
    ├── handovers/               # session handover notes
    └── curator/logs/            # LOG.md heartbeat + per-pass run notes
```

## A few load-bearing choices
- **`db/` is in the manifest's `skipDirs`** — the engine and linter never parse the SQLite binary.
- **Generated-view dirs vs hand-authored dirs are kept separate** so a glance tells you what you may edit:
  `notes/ journal/ projects/ plans/ people/` are yours; `contacts/ accounts/ finances/ health/ places/`
  are regenerated ([[rule-derived-views-are-generated]]).
- **`migrations/` is the only path that writes the DB** ([[doc-governance-model]]).

## Browse the graph in Obsidian
Open the **repo root** as an Obsidian vault (`node_modules`, `db/`, `_meta/logs/` are excluded via
`.obsidian/app.json`). Nodes are color-coded by `#type/<type>` (configured in `.obsidian/graph.json`):

| 🟡 moc | 🔴 agent | 🟠 loop | 🔵 rule | 🟣 skill | ⚪ tool | 🩶 doc |
|---|---|---|---|---|---|---|
| 🫒 decision | 🟢 note | 🩵 journal | 🌊 plan | 🌿 project | 🌸 person | 🧡 contact / account | 🟨 summary |

## Related
[[conventions]] · [[doc-storage-model]] · [[doc-governance-model]] · [[moc-synapse]]
