---
id: conventions
type: doc
title: Synapse conventions — the schema layer
tags:
  - type/doc
  - area/meta
  - status/active
---

# Synapse conventions (the schema layer)

How this vault is structured so that Obsidian, the render engine, and the linter all agree.
Read before authoring or migrating notes.

Synapse is a manifest-driven, local-first personal knowledge system with **two substrates joined by
one ontology** (`_meta/tools/context.manifest.json`):

- **Markdown-in-Git** — the source of truth for *knowledge*: notes, journal, plans, projects, people.
- **Local SQL** — the source of truth for *records*: contacts, accounts, transactions, health,
  locations, addresses — anything you aggregate, filter, or relate.

This document is deliberately generic and tool/data-agnostic: it describes the **pattern**, not any one
person's data. See also [[context-engine-guide]] (how the renderer reads this schema) and
[[doc-storage-model]] (the Markdown↔SQL split and the two projection directions).

## 1. Every note has a globally-unique, kebab-case basename
Both Obsidian (`[[wikilink]]`) and the render engine address notes **by basename** — a duplicate
basename silently shadows a note in both. So every note's `id` equals its filename without `.md`, is
globally unique, and is kebab-case. The filename **prefix implies the `type:`** (`rule-*`→`rule`,
`agent-*`→`agent`, `hub-*`→`hub`, `note-*`→`note`, …), and `lint.mjs` enforces the match.

## 2. Frontmatter
Each note opens with YAML frontmatter terminated by a line that is exactly `---`.

- **Required on every note:** `id`, `type`, `title`, `tags` — and the `tags:` list must contain
  `type/<type>` matching the `type:` field.
- **Agents additionally** carry `purpose` and `invokes_skills` (may be `[]`).
- **Generated notes** (derived views, indexes) additionally carry `generated: true` and a `source:`
  pointer (the canonical row, query, or table) — and are **never hand-edited** (§6,
  [[rule-derived-views-are-generated]]).
- The engine reads `type:` (drives render ordering) and tags like `area/<domain>`, `status/<status>`
  (the `lean` profile drops `status/draft`).
- **No secrets** inline — keys, tokens, passwords (`lint.mjs` scans for them). The scanner does **not**
  catch account numbers or balances; those are protected by the read-only credential + derived-view
  design and by the repo being private, not by the linter.

## 3. Links are `[[basename]]` — and the field decides the role
- Link by basename only — **no path-qualified links** (`[[a/b/note]]` will not resolve).
- A link only reaches a briefing if it sits in the **field whose role the manifest traverses to that
  target's `type:`** ([[rule-synapse-edges-by-role]]). Put each link in the right field:
  - rules → `applies_rules` · tools/skills → `uses_tools` / `invokes_skills` · agents → `delegates_to`
    · docs → `references_docs`
  - everything else → `related`, where the engine resolves the role by the **target's type**: a `hub`
    is *navigated to*, a `note`/`journal`/`plan`/`project`/`contact`/`account`/`summary` is *bound* (it
    rolls up as a member of any hub it links to), and a `person`/`decision`/`tool`/`glossary` is
    *attached* (bidirectional).
- **Hubs compose (sub-hubs).** A `hub` → `hub` link is *navigated*, not bound, so hubs nest into trees. A
  sub-hub **declares its parent** in `related` (child-declares-parent, exactly like a member declares its
  hub); the parent does not list the child in frontmatter. `NAVIGATES` is **bidirectional**, so that one
  edge renders both ways — the parent pulls its sub-hubs, a sub-hub pulls its parent — and it is
  depth-capped per profile (0 `lean` / 1 `standard` / 99 `fat`), so a parent shows each sub-hub's *own
  body* but **not** the sub-hub's members until `fat`. Because direction is structural, `curator
  hub-career/<Tab>` navigates one level down into sub-hubs. See [[decision-0007-composable-sub-hubs]]
  (worked example: [[hub-career]] → [[hub-courses]] → course notes).
- **Sub-hub workspace directory.** A sub-hub you *work in* (courses, a heavy project) lives at
  `hub/<slug>/hub-<slug>.md` — that directory is its workspace for typed members and non-note helpers.
  Map-only hubs may stay flat at `hub/hub-<slug>.md`. Discovery finds both.
- Link liberally; a `[[name]]` with no target yet is fine — render just skips it, and it marks intent.

## 4. Single source of truth — across both substrates
Every fact lives in exactly one place, edited in place, never duplicated
([[rule-synapse-single-source-of-truth]]). With two substrates the rule splits cleanly by domain:

- **Markdown is canonical for knowledge** — notes, journal, plans, projects, people-narrative.
- **SQL is canonical for records** — contacts, accounts, transactions, health, locations, addresses.

Neither overrules the other in its own domain. Where the two meet, one side is canonical and the other
is **generated, not authored** (§6).

## 5. Note types (the taxonomy)
| Layer | Types | Substrate | Notes |
|---|---|---|---|
| **Map** | `hub` | Markdown | one hub per domain (`hub-finances`, `hub-contacts`, `hub-<project>`) + the master `hub-synapse`; hubs **nest** — a sub-hub lists its parent in `related` ([[decision-0007-composable-sub-hubs]]) |
| **Knowledge** | `note` `journal` `project` `plan` | Markdown (canonical) | the prose second brain; members of a domain hub |
| **People** | `person` `contact` | `person` = Markdown narrative; `contact` = generated view | record + optional narrative, **linked, never duplicated** |
| **Records** | `contact` `account` `summary` | SQL (canonical) → generated Markdown view | per-row views (`contact`, `account`) + aggregate summaries (finance/health/geo) |
| **Cross-cut** | `decision` `glossary` | Markdown | bidirectional attachments referenced from many notes |
| **Method** | `agent` `rule` `skill` | Markdown | the HOW; agents wikilink the rules + skills they obey/use |
| **Reference** | `tool` `doc` | Markdown | shared facts the method layer cites |
| **Process** | `loop` | Markdown | standing autonomous loops (run-until-dry); see [[loop-maintain-synapse]] |

High-volume / time-series record domains (transactions, health, geolocation, addresses) are **SQL-only**
— they get no per-row note (that would bury the graph); they surface through `summary` notes and
ad-hoc text-to-SQL.

## 6. Generated projections — two directions, both never hand-edited
The two substrates each project into the other. Whichever side is canonical, the other is **generated**:

- **SQL → Markdown (derived views).** The DB row is canonical; a read-only Markdown projection
  (`contacts/<slug>.md`, `accounts/<slug>.md`, `summary-finances-<period>.md`) is regenerated so records
  stay linkable in Obsidian and visible in git.
- **Markdown → SQL (indexes).** The note is canonical; a SQL projection is regenerated so the model can
  query with text-to-SQL — the **`.md` index** (`notes` + `note_links` tables: what links to what, what's
  an orphan, what's oversize) and the **`plans`** table (built from plan-note frontmatter).

Either direction, the generated side carries `generated: true` + `source:` and is **never hand-edited**
([[rule-derived-views-are-generated]]). Edit the canonical side; regeneration overwrites the projection.
A hand-edit to a generated artifact is a lint violation → escalate.

## 7. Skills are pointer notes
Each `skill-*.md` is a thin Goal + Steps + Related summary that renders into agent briefings and points
to the canonical executable playbook at `.claude/skills/<name>/SKILL.md` (single source — no drift).

## 8. Loops
A `loop` note documents a *standing, autonomous process* an owner agent re-runs until an exit condition
(detect → heal → verify, repeat; stop when "dry"). Unlike a `recipe` (one-shot) or a `pipeline` (fixed
DAG), a loop **adapts each pass on a signal** and has an explicit **exit condition**. Frontmatter carries
the contract: `goal`, `exit_condition`, `signal`, `pattern`, `guardrails`, `owner_agent`, `cadence`, and
`state` (its external memory — git + a run-log, since context does not persist across passes). The first
loop is [[loop-maintain-synapse]], owned by [[agent-curator]].
