# 🎓 Synapse Tutorial — how this thing works, from zero

> **Audience:** anyone setting up or extending a Synapse vault. **Goal:** after ~45 minutes you understand
> the vault's structure, every abstraction in it (agents, rules, skills, tools, docs, loops, the two
> substrates), how an agent is built, how context gets assembled into a briefing and handed to a local
> model, and how every change passes through a human-gated diff. The [README](README.md) tells you how to
> *install and run* the vault — this tutorial teaches you how it's *designed*, so you can read it, extend
> it, build your own agents, and know exactly what the engine pulls into a briefing and why.

**Two ways to take this tutorial — use both:**

1. **Self-guided** — read the lessons below and open the linked files in Obsidian (or any editor). Every
   example is a real note or command in *this* vault; nothing here is hypothetical, and every closure
   number below was produced by running the command shown against the live vault.
2. **Guided by your agent** — Synapse agents run on **OpenCode** against a **local Ollama** model over
   Tailscale (no API key, no cloud). Once you've sourced the launcher (`source _meta/tools/agents.sh`),
   open a session and paste:

   > Read TUTORIAL.md and give me the guided tour. Go lesson by lesson: explain each concept, then SHOW me with a real file from this vault (open it, point at the lines), and give me one small exercise before moving on. Start with Lesson 0.

You can also jump to one lesson — see the **🤖 Ask your agent** box at the end of each lesson. (All
commands run from the vault root; this file lives at the vault root too.)

---

## Lesson 0 — the mental model (read this even if you skim the rest)

Synapse is a **private, local-first personal knowledge system** — a manifest-driven context vault you own
and run yourself. Internalize five ideas and everything else follows.

1. **Notes are atoms.** One file = one fact / concept / record / playbook, kebab-case filename with a type
   prefix (`rule-derived-views-are-generated.md`, `doc-storage-model.md`, `moc-finances.md`). Every term
   is defined *once* and linked from everywhere else — no copy-paste redundancy, no drift.
2. **Links make the graph — but the engine only follows *frontmatter role fields*.** Notes reference each
   other with `[[wikilinks]]`. Inline `[[links]]` in the *body* are for human readers and Obsidian's graph
   view; the renderer does **not** traverse them. To land in a briefing, a link must live in a frontmatter
   field whose *role* the manifest traverses (Lesson 2 and 5). This is the single biggest thing to get
   right.
3. **Render assembles a briefing.** `_meta/tools/render.mjs` starts at any note, follows its *typed roles*
   outward to the breadth a profile selects, and concatenates the bodies into **one paste-ready blob** —
   the system prompt for an agent session. That's the deterministic half. An **opt-in second phase**
   (`augment.mjs`) adds *semantic recall* — embedding search that appends conceptually-related notes the
   typed graph never linked, clearly labeled and non-authoritative. Together that's **hybrid retrieval**
   (Lesson 5).
4. **Agent = method × target = domain × profile = a dial.** An "agent" is not a running bot — it's a saved
   **context recipe** (a Markdown note that says, as frontmatter links, "for this job, here are my rules,
   skills, tools"). The agent is the *method*; a MOC (map of content) you fuse it with is the *domain*; the
   profile (`lean`/`standard`/`fat`) is *how much* context. Rendering the note packs the briefcase;
   launching OpenCode with that briefing is the agent "running."

5. **Synapse's defining twist — two substrates, one ontology, all mutation human-gated.** This is what
   makes Synapse different from a plain LLM-wiki:

   - **Markdown-in-Git is canonical for *knowledge*** — `note`, `journal`, `plan`, `project`, `person`
     narrative, `decision`. Authored in Obsidian, versioned in git, read by the render engine.
   - **Local SQLite is canonical for *records*** — contacts, accounts, transactions, health, places,
     addresses. One file (`db/synapse.db`), reachable only on your machine / Tailnet.
   - They are joined by **one ontology** (the manifest's type system) and kept consistent by **two
     generated projections**: **SQL → Markdown views** (`contacts/<slug>.md`, `accounts/<slug>.md`,
     `summary-*`) so records stay linkable in Obsidian; and **Markdown → SQL indexes** (`notes` +
     `note_links` + `plans` tables) so the model can answer structural questions with text-to-SQL.
   - **Reads are free; every write is a reviewable diff a human merges.** Markdown rides git's PR diff;
     SQL rides **migration files** through the *same* PR gate. The agent *proposes*, a human *merges*, a
     runner *applies*. Nothing mutates the DB unattended (Lesson 6). The rule of thumb: **if you
     aggregate, filter, sort, or relate it → SQL. If you read, link, or narrate it → Markdown.**

> 🤖 **Ask your agent:** *"Read TUTORIAL.md Lesson 0, then prove the 'agent = context recipe' idea: show
> me `agents/agent-curator.md` raw, then run `node _meta/tools/render.mjs agent-curator --profile lean
> --dry-run` and tell me which notes got pulled in that weren't in the file itself, and which frontmatter
> field pulled each one."*

---

## Lesson 1 — the layout: where things live

Synapse splits along one seam: **the method/reference/governance layers and the knowledge note-types are
Markdown in git; the records live in SQLite, surfacing as generated view directories.**

```
wiki/                              ← THE VAULT ROOT
├── README.md                      ← install + daily usage
├── TUTORIAL.md                    ← this file (no frontmatter — the linter ignores it)
├── AGENTS.md                      ← runtime entry note for OpenCode
├── moc-synapse.md                   ← 🧭 THE master hub — start browsing here
│
│   ── KNOWLEDGE (Markdown canonical) ─────────────────────────────
├── notes/                         ← note-*    — the prose second brain (atoms)
├── journal/                       ← journal-* — append-only work/day log
├── projects/                      ← project-* — multi-note efforts
├── plans/                         ← plan-*    — intentions (also indexed into SQL)
├── people/                        ← person-*  — narrative about a person (links a contact row)
│
│   ── RECORDS (SQLite canonical → generated Markdown views) ──────
├── contacts/                      ← contacts/<slug>.md   (generated: SQL → MD)
├── accounts/                      ← accounts/<slug>.md   (generated: SQL → MD)
├── finances/                      ← summary-finances-*    (generated aggregates)
├── health/                        ← summary-health-*      (generated aggregates)
├── places/                        ← summary-places-*      (generated aggregates)
│
│   ── METHOD / REFERENCE / MAP / PROCESS (Markdown) ──────────────
├── agents/                        ← agent-*  — job briefings (curator, reconciler, ingester, oracle)
├── rules/                         ← rule-*   — hard constraints with a "why"
├── skills/                        ← skill-*  — pointer notes → .opencode executable playbooks
├── tools/                         ← tool-*   — external instruments (git, gh, sqlite, render, lint, opencode)
├── docs/                          ← doc-*    — operator-facing architecture docs
├── moc/                           ← moc-*    — per-domain hubs (finances, contacts, health, …)
├── loops/                         ← loop-*   — standing autonomous processes (run-until-dry)
│
│   ── THE SQL GATE + PLUMBING ────────────────────────────────────
├── migrations/                    ← NNNN-*.sql — the ONLY way the DB changes (audit log + revert path)
├── db/                            ← synapse.db  — GITIGNORED: derived, sensitive, binary
├── inbox/                         ← human ↔ agent handoff: attention/ · curator/logs/ · handovers/
└── _meta/                         ← conventions, the engine guide, tools/ (render/lint/gen-*/apply-migrations/…)
```

Navigation rules worth memorizing:

- **Basenames are globally unique, and links resolve by basename.** `[[rule-derived-views-are-generated]]`
  works no matter which folder the file sits in — **no path-qualified links** (`[[a/b/note]]` won't
  resolve). Moving a file never breaks the graph; a *duplicate* basename silently shadows a note in both
  Obsidian and the engine (`_meta/conventions.md` §1).
- **Records get no per-row note when they're high-volume.** `contact` and `account` are low-cardinality,
  so each gets one generated view. Transactions, health metrics, visits — those are **SQL-only**; they
  surface through `summary-*` aggregate notes and ad-hoc text-to-SQL, never one note per row (that would
  bury the graph).
- **Browse with MOCs, work with agents.** `moc-synapse` is the root hub; each domain has its own
  (`moc-finances`, `moc-contacts`, …). A MOC is a table of contents, not a briefing — at `standard` it
  expands to its whole domain, so render it that way when you want the domain's full map.

> **Fresh-vault note:** in a brand-new Synapse the knowledge dirs (`notes/`, `projects/`, …) and the record
> view dirs (`contacts/`, `accounts/`, …) start empty — only the schema layer, the docs, and the domain
> MOCs exist. That's why a domain MOC's closure is small until records and notes land (Lesson 5).

> 🤖 **Ask your agent:** *"Tour the layout from TUTORIAL.md Lesson 1: `ls` the vault top-level dirs, open
> `moc-synapse.md` and one `moc/moc-*.md`, and tell me in one line why a transaction lives in SQLite while a
> meeting note lives in `notes/`."*

---

## Lesson 2 — anatomy of a note

Open any typed note and you'll see the same shape. Here's the real frontmatter of `rules/rule-synapse-edges-by-role.md`:

```yaml
---
id: rule-synapse-edges-by-role       # = filename minus .md, always; globally unique; kebab-case
type: rule                         # one of the vault's note types (Lesson 3)
title: Put each link in the role-field the engine actually traverses
tags:
  - type/rule                      # the type, encoded a third time as a tag
  - area/governance
  - status/active
provenance: ["the manifest role/field/endpoint model", "Emmanuel 2026-06-15"]
---
```

And the real frontmatter of `agents/agent-curator.md` shows the role fields in action:

```yaml
---
id: agent-curator
type: agent
title: Curator & vault steward (self-healing)
tags: [type/agent, area/governance, status/active]
purpose: "Maintain the whole vault — detect drift, autofix the unambiguous, dispatch a reconciler, escalate the rest, open one human-gated PR"
profile: standard
uses_tools: ["[[tool-lint]]", "[[tool-render]]", "[[tool-git]]", "[[tool-gh]]", "[[tool-sqlite]]"]
applies_rules: ["[[rule-synapse-fail-loudly]]", "[[rule-derived-views-are-generated]]", ...]
delegates_to: ["[[agent-reconciler]]"]
references_docs: ["[[conventions]]", "[[context-engine-guide]]", "[[doc-governance-model]]"]
related: ["[[decision-0003-human-gated-mutation]]", "[[decision-0004-opencode-local-ollama-runtime]]"]
invokes_skills: ["[[skill-maintain-synapse]]"]
---
```

Three things to notice:

**Type is encoded three ways.** Filename prefix (`agent-…`), frontmatter `type: agent`, and the tag
`type/agent`. The linter **enforces that the prefix and `type:` agree** — name a file `rule-foo.md` with
`type: skill` and `lint.mjs` errors — and it requires the matching `#type/<type>` tag in `tags:`. Keep all
three in sync (`_meta/conventions.md` §1–2).

**Edges are *roles*, and the engine reads them only from frontmatter.** This is the core authoring
decision:

| Edge | Where | Walked by render? | Example |
|---|---|---|---|
| **Frontmatter role field** | `applies_rules`, `invokes_skills`, `uses_tools`, `delegates_to`, `references_docs`, `related` | **Yes** — these *are* the graph the engine walks | `uses_tools: ["[[tool-sqlite]]"]` |
| **Inline `[[wikilink]]`** in the body | prose | **No** — for human readers + Obsidian only | "regenerate its view ([[rule-derived-views-are-generated]])" |
| **Tag** | `tags:` | No (filter only) | `area/finances`, `status/draft` (dropped at `lean`) |
| **Scalar** | a single value | No | `profile: standard`, `generated: true`, `source: <row>` |

> ⚠️ **The trap:** a link's *field* decides whether it renders, and `related` is field-sensitive *by the
> target's type*. `related: ["[[conventions]]"]` looks linked but renders **nothing** — a `doc` is not a
> `related` endpoint; docs reach a briefing only via `references_docs` ([[rule-synapse-edges-by-role]]). A
> `[[rule-x]]` mentioned only in prose is invisible to `render.mjs`. Body links still matter — they're how
> a human jumps around and how Obsidian draws the graph — but they don't pack the briefcase.

**Schema is real and enforced.** `_meta/conventions.md` defines the taxonomy; `_meta/tools/lint.mjs`
enforces it:

- **Prefix ↔ `type:` must agree**, and `tags:` must carry the matching `type/<type>`.
- **Required fields per note:** `id`, `type`, `title`, `tags` on *every* note. An `agent` additionally
  **must** carry `purpose` and `invokes_skills` (it may be `[]`). A **generated** note must carry
  `generated: true` and a `source:` pointer.
- **Generated-view guard** — a hand-edit to a `generated: true` artifact is a lint violation → escalate
  ([[rule-derived-views-are-generated]]). The canonical side is edited; regeneration overwrites the view.
- **Secret scan** — keys, tokens, passwords inline fail lint. (It does **not** catch amounts or account
  numbers — those rest on the private repo + read-only query credential + the derived-view design, not the
  linter.)
- **`--strict`** additionally fails on broken `[[wikilinks]]` and unbalanced code fences; engine
  invariants (e.g. every non-master `moc` at `standard` must have `members ≥ 1` and stay within `3×median`
  tokens) are checked over the whole index.
- **Advisory** (never fails the build): oversize notes (split candidates) and orphans.

Run `node _meta/tools/lint.mjs` before you commit; `lint.mjs --strict` is the gate.

> 🤖 **Ask your agent:** *"From TUTORIAL.md Lesson 2: open `rules/rule-synapse-edges-by-role.md` and
> `agents/agent-curator.md`, and for each frontmatter field tell me which consumer reads it — the render
> engine (as which role), the linter, Obsidian, or just humans. Then point out one inline body link that
> render will NOT follow."*

---

## Lesson 3 — the abstractions, one by one

Synapse's types span six layers across **two substrates** (`_meta/conventions.md` §5). Grouped by what
they're for, with a real example of each:

### Knowledge (Markdown canonical) — the prose second brain

| Type | What it is | Real example / location |
|---|---|---|
| **note** | one atomic fact/idea | `notes/note-*.md` |
| **journal** | append-only day/work log entry | `journal/journal-*.md` |
| **plan** | an intention (also indexed into the SQL `plans` table) | `plans/plan-*.md` |
| **project** | a multi-note effort | `projects/project-*.md` |
| **person** | narrative about a person; links a `contact` row, never duplicates it | `people/person-*.md` |
| **decision** | an ADR — one structural choice, recorded | [[decision-0003-human-gated-mutation]], [[decision-0004-opencode-local-ollama-runtime]] |

### Records (SQLite canonical → generated Markdown views)

| Type | What it is | Real example / location |
|---|---|---|
| **contact** | one generated view per contact row | `contacts/<slug>.md` (`generated: true`, `source:` the row) |
| **account** | one generated view per account row | `accounts/<slug>.md` |
| **summary** | a generated *aggregate* over high-volume rows (finance/health/geo) | `finances/summary-finances-<period>.md` |

> **Records are views, not authored notes.** The DB row is canonical; the `.md` is a read-only projection
> regenerated by `gen-views.mjs`. You never hand-edit them; to change a record you propose a **migration**
> (Lesson 6). High-volume domains (transactions, health metrics, visits) get *no* per-row note — only
> `summary-*` rollups and text-to-SQL.

### Method (Markdown) — these compose into agents

| Type | What it is | One-liner test | Real example |
|---|---|---|---|
| **agent** | a job briefing: mission + linked rules/skills/tools | "who do I want to *be* for this task?" | [[agent-curator]], [[agent-reconciler]], [[agent-ingester]], [[agent-oracle]] |
| **rule** | a hard constraint with a *why* | "could violating this corrupt data, lose trust, or break a briefing?" | [[rule-derived-views-are-generated]], [[rule-synapse-human-gated-push]] |
| **skill** | a *pointer note* — a thin Goal/Steps/Related summary linking the real playbook | "is there an executable playbook behind this?" | [[skill-maintain-synapse]] |

> **Skills are pointer notes** (`_meta/conventions.md` §7). Each `skill-*.md` is a short summary that
> renders *into* an agent briefing; the canonical, runnable playbook lives at `.opencode/command/<name>.md`
> (single source — no drift). That's why you rarely render a `skill-*` alone — the agent that
> `invokes_skills` it pulls the summary in automatically.

### Reference (Markdown) — shared facts the method cites

| Type | What it is | Real example |
|---|---|---|
| **tool** | an external instrument we drive, and its quirks | [[tool-git]], [[tool-gh]], [[tool-sqlite]], [[tool-render]], [[tool-lint]], [[tool-opencode]] |
| **doc** | operator-facing architecture doc (not a graph leaf) | [[doc-storage-model]], [[doc-governance-model]], [[doc-agent-architecture]], [[doc-sql-schema]] |

### Map (Markdown) & Process (Markdown)

| Type | What it is | Real example |
|---|---|---|
| **moc** | map of content — a hub that indexes a domain | [[moc-finances]], [[moc-contacts]], [[moc-synapse]] (root) |
| **loop** | a standing, autonomous *process* (detect → heal → verify, run until dry, with an exit condition) | [[loop-maintain-synapse]] |

How the method types differ *in practice*: a **rule** says *don't / always* (`rule-synapse-human-gated-push`:
never force-push, never self-merge), a **skill** says *how* (`skill-maintain-synapse`: the steps of one
maintenance pass, pointing at the runnable playbook), a **tool** says *what you're driving and its sharp
edges* (`tool-sqlite`: read-only query credential vs the migration runner), and a **loop** says *keep
doing this until dry* (`loop-maintain-synapse`: re-run the pass nightly until lint is clean and no view
diverges).

`inbox/` and `journal/` hold *work-in-flight*; inbox notes and journal entries are plain (no `type:`), so
the linter ignores them — covered in Lesson 6.

> 🤖 **Ask your agent:** *"TUTORIAL.md Lesson 3 quiz: I'll describe five pieces of information, you tell me
> which substrate (Markdown or SQL) and which note type each becomes, and why. Then reverse it — open one
> note of each method type plus one `moc` and justify its type."*

---

## Lesson 4 — how an agent is made

An agent note is ~30–55 lines. The power is in what its frontmatter links. Dissecting
[[agent-curator]]:

```
## Detect       ← the drift signals it looks for
## Autofix      ← what it fixes directly (unambiguous & reversible)
## Escalate     ← what it refuses to guess on (Options to inbox/attention/, then stop)
## Delegate     ← the maker≠checker handoff to the reconciler
## Boundaries   ← where it stops (.md + migrations only; never write the DB; never self-merge)
```

…plus the frontmatter role edges from Lesson 2 — and these are what actually shape the briefing:

- `applies_rules:` → the **CONSTRAINS** role (the rules that bind this job)
- `invokes_skills:` + `uses_tools:` → the **USES** role (the procedures + instruments it calls)
- `delegates_to:` → the **DELEGATES** role (other agents it hands off to)
- `references_docs:` → the **REFERENCES** role (operator docs it cites)

`invokes_skills` is **mandatory** on an agent (it may be `[]`, as the reconciler and ingester have it — a
scoped doer needs no skill of its own). The curator declares `invokes_skills: ["[[skill-maintain-synapse]]"]`.

### The roster — three writers + one reader (maker ≠ checker)

Synapse's core loop runs on **three writers, one rule: the agent that writes an edit never approves it**
([[doc-agent-architecture]]):

- **[[agent-curator]]** — the *steward*. Owns [[loop-maintain-synapse]]: orient on the inbox, detect drift
  (lint + DB↔view divergence + orphans + pending captures), heal the unambiguous, dispatch a reconciler
  per drifted unit, **verify each diff**, escalate the rest, open one human-gated PR, log the pass.
  Detects and plans; rarely edits content itself.
- **[[agent-reconciler]]** — the *scoped doer*. Given one drifted unit and its `moc-<domain>` briefing,
  makes the minimal edit (regenerate a stale view, fix a unit's notes) and reports back. Never detects,
  never opens a PR, never writes the DB.
- **[[agent-ingester]]** — the *capture ingester*. Atomizes a freeform `inbox/` dump into one-idea-per-file
  notes (or proposes record rows as a migration), carrying `provenance:`, then clears the entry.

The **reconciler (maker)** writes; the **curator (checker)** reviews the diff — in scope? single-sourced?
schema-clean? no stray edits? — repairs the unambiguous, escalates the rest, and is the only one that
opens the PR. A human merges. From-scratch authoring is escalated, never auto-run.

Alongside the writers sits one **reader**:

- **[[agent-oracle]]** — the *read front door*. Point it at a `moc-<domain>` and ask: it answers grounded in
  that domain's typed closure plus query-driven semantic recall, **cites every claim**, and abstains when
  the context is silent ([[rule-answer-grounded]]). It never edits, migrates, or opens a PR — its one
  action is to **propose a consent-gated handoff** to a writer when it spots a gap (e.g. `oracle
  moc-finances "did I note anything about budgeting?"`).

**Why this design works:** the agent file stays tiny and stable, while the rules/skills/tools it links
evolve independently. Tighten a constraint in [[rule-derived-views-are-generated]] once, and every agent
that reaches it is instantly smarter.

### Build-your-own agent (the actual procedure)

There's no template dir — you scaffold from an existing note:

1. **Copy a small agent:** `cp agents/agent-reconciler.md agents/agent-<slug>.md`. Fix `id`, `title`,
   `purpose`, `tags` (start `status/draft`), and set `profile:` (`lean` for scoped doers, `standard` for
   planners/domain-wide jobs — Lesson 5).
2. **Write the body** (mission / when / how / boundaries). Keep "how" tight — a long procedure wants to be
   a `skill-*` pointer note the agent links instead.
3. **Wire the role edges:** `applies_rules`, `uses_tools`, `invokes_skills` (present, may be `[]`),
   `delegates_to` if it hands off, `references_docs` for docs. Targets that don't exist yet are allowed
   while drafting; `--strict` lint flags them.
4. **Validate + try it:** `node _meta/tools/lint.mjs`, then
   `node _meta/tools/render.mjs agent-<slug> --profile lean --dry-run` to see exactly what the closure
   pulls in (dry-run lists the notes without printing the blob).
5. **No registration step.** `agents.sh` auto-discovers the new agent on next `source _meta/tools/agents.sh`
   — it generates one shell function per `agents/agent-*.md`, reading the note's `profile:` field for the
   default.

> 🤖 **Ask your agent:** *"Per TUTORIAL.md Lesson 4, help me scaffold a draft agent for `<job>` — copy
> `agent-reconciler`, propose the mission and the minimal rule/skill/tool links from what already exists,
> run lint and a `--dry-run` render, and show me the closure. Don't invent new notes unless a needed skill
> truly doesn't exist."*

---

## Lesson 5 — harnessing context: the role engine, profiles, fusion

This is what makes the vault *usable by a model* instead of just readable by humans.

### Selection is by ROLE, not by hops

Here's the Synapse engine in one table (`_meta/context-engine-guide.md` + `_meta/tools/context.manifest.json`).
Seven named roles, each reading specific frontmatter fields and reaching specific target `type:`s:

| Role | Field(s) | Direction | Reaches `type:` |
|---|---|---|---|
| **CONSTRAINS** | `applies_rules` | forward | `rule` |
| **USES** | `invokes_skills`, `uses_tools` | forward | `skill`, `tool` |
| **DELEGATES** | `delegates_to` | forward | `agent` |
| **BINDS** (reverse name `members`) | `related` | reverse | `note` `journal` `project` `plan` `contact` `account` `summary` |
| **ATTACHES** | `related` | both | `person` `decision` `tool` `glossary` |
| **NAVIGATES** | `related` | forward | `moc` |
| **REFERENCES** | `references_docs` | forward | `doc` |

**The one trick:** BINDS, ATTACHES, and NAVIGATES all read the *same* `related` field. The engine tells
them apart by the **type of the note at the far end** — a `related` link landing on a
note/journal/project/plan/contact/account/summary is a **member** (BINDS); one landing on a
person/decision/tool/glossary is an **attachment** (ATTACHES); one landing on an `moc` is a **sibling hub**
(NAVIGATES). Those type-sets are **disjoint**, so every `related` link belongs to exactly one role — no
ambiguity, no double-counting.

And **BINDS is *reverse***: a domain hub doesn't list its members; the members list the hub
(`related: ["[[moc-finances]]"]`), and the engine discovers them by asking "who points back at me?" That's
why adding an account view that `related`-links its MOC instantly makes it appear in the MOC's `standard`
briefing — with zero edits to the MOC.

### Profiles — the role-set dial

A profile is a preset *bundle of roles*, not a hop count (`context.manifest.json` → `profiles`):

| Profile | Role-set | ~Budget | Use |
|---|---|---|---|
| `lean` | self + CONSTRAINS + USES + DELEGATES | ~4K tok | an agent + its rules/skills/tools/delegations; or a single unit note. Drops `status/draft`. |
| `standard` | lean + `target` + members (BINDS) + ATTACHES + NAVIGATES@1 + REFERENCES | ~15K tok | a domain **MOC** — pulls its members, attachments, sibling hubs, and docs |
| `fat` | standard but **transitive** over NAVIGATES + members (fixpoint BFS) | ~30K+ tok | deep dives / maximum context |

**Auto-upgrade.** The manifest's `autoUpgrade: { "moc": "standard" }` means starting from a hub
(`type: moc`) and asking for `lean` bumps you to `standard` automatically — a bare hub at lean carries
almost nothing useful. Finer-grained starts (a `note`, `plan`, `contact`) stay at whatever you asked for.

These are not hypothetical numbers — here are **real closures from this vault**, each produced by the
exact command shown with `--dry-run`:

```bash
node _meta/tools/render.mjs agent-curator                          --profile lean     --dry-run   # closure=18  ~7.3K tok
node _meta/tools/render.mjs agent-curator                          --profile standard --dry-run   # closure=24  ~11.9K tok
node _meta/tools/render.mjs agent-curator loop-maintain-synapse      --profile standard --dry-run   # closure=25  ~12.8K tok
node _meta/tools/render.mjs moc-finances                           --profile lean     --dry-run   # auto→standard: closure=4 ~2.0K
node _meta/tools/render.mjs moc-finances                           --profile fat      --dry-run   # closure=9  ~3.0K tok
```

Read the diffs by role:
- **lean → standard** on `agent-curator` (18 → 24) adds the six `references_docs` (REFERENCES role:
  `conventions`, `context-engine-guide`, `doc-governance-model`, `doc-maintainer-loop`) and the two
  `related` decisions (ATTACHES) — the docs and ADRs the steward cites, which `lean` omits.
- **`moc-finances` at lean prints `profile=standard`** in its header even though you asked for lean —
  that's `autoUpgrade` firing. Its closure is small (4) because this is a fresh vault: the finances domain
  has no account views or summaries linking back yet (BINDS finds no members). It pulls itself,
  `moc-synapse` (NAVIGATES), and its two `references_docs` (`doc-sql-schema`, `doc-storage-model`). As
  records land, the same command's closure grows with zero edits to the MOC.

### Render = role-closure assembly + fusion

```bash
node _meta/tools/render.mjs agent-curator --profile lean                              # one agent's briefing
node _meta/tools/render.mjs agent-curator loop-maintain-synapse --profile standard      # agent × process
node _meta/tools/render.mjs agent-reconciler moc-finances --profile standard --dry-run # method × domain
```

`render.mjs` (zero dependencies, prints to stdout, sends nothing anywhere) reads the manifest, indexes the
vault, starts at the note(s) you name, expands the profile's roles, and prints the bodies as **one blob in
a deterministic order** — start ids first, then the manifest's `typePriority`, ties broken by name. **Same
start ids + same flags = byte-identical output**, every time (reproducible, reviewable). Useful flags:
`--dry-run` (list ids+types, no bodies) and `--copy` (to clipboard, for pasting into any tool).

Passing **two start nodes** (an agent + a `moc-<domain>`) is the `method × domain` fusion from Lesson 0 —
the agent brings rules/skills/tools, the MOC brings the domain. Real example:

```bash
node _meta/tools/render.mjs agent-reconciler moc-finances --profile standard --dry-run  # closure=17 ~8.7K tok
node _meta/tools/render.mjs agent-curator    moc-contacts --profile standard --dry-run  # closure=29 ~14.2K tok
```

### Hybrid retrieval — the opt-in semantic second phase

The closure above is **deterministic**: it reaches only what you *explicitly linked*. A task that spans a
domain you never named — or never linked — is invisible to it. Synapse closes that gap with an **opt-in
semantic-recall layer** ([[doc-semantic-recall]], [[decision-0005-hybrid-retrieval]]) — classic **hybrid
retrieval** (graph + vector), in two clean phases:

1. **Deterministic seed (Phase 1, unchanged).** `render.mjs` walks the typed-link closure → the
   byte-identical briefing above. It stays pure and offline; the semantic layer never touches it.
2. **Semantic augment (Phase 2, new).** `_meta/tools/augment.mjs` shells `render.mjs` for that seed, then
   embeds the **user's task**, cosine-ranks notes **not already in the closure**, drops anything below a
   similarity floor (`SYNAPSE_MIN_SIM`, default 0.45), takes the top-`--k` (default 6), and **appends** a
   clearly-labeled `## Semantically related (not yet linked)` section of short excerpts.

```sh
node _meta/tools/augment.mjs agent-curator moc-finances --profile standard --task "did I note anything about budgeting?"
```

**All local, no new deps.** Embeddings come from the **same local Ollama over Tailscale** that runs the
agents ([[tool-ollama-embeddings]]) — default model `mxbai-embed-large` (1024-dim; override with
`SYNAPSE_EMBED_MODEL`). The vectors live as BLOBs in a generated `note_vectors` table in `db/synapse.db` —
another **derived projection** ([[rule-derived-views-are-generated]]), rebuilt by `gen-embeddings.mjs`,
gitignored, never canonical. Cosine runs in JS (brute force is ample at personal-vault scale); `sqlite-vec`
is the documented scale-up path.

**The determinism boundary (the key idea).** Semantic results are **additive, labeled, and
non-authoritative** ([[rule-semantic-suggests-links-decide]]): the deterministic briefing stays the spine,
a similarity hit never silently drives a mutation, and when a hit is genuinely relevant the agent
**promotes it to a typed `related:` link** — turning a one-off fuzzy match into a permanent, deterministic
edge. Semantic recall is thus a *discovery mechanism that feeds the graph*. If Ollama is unreachable or the
index is empty, augment still emits the full deterministic briefing plus a `(semantic augment skipped:
<reason>)` note — it never blocks the spine.

### The launcher commands

After `source _meta/tools/agents.sh` (the installer, `node _meta/tools/install.mjs --write`, adds that
line to your shell rc), every agent is a one-word command that renders the briefing and launches OpenCode
with it as the prompt:

```bash
vault-agents                                  # list every agent + purpose + default profile
vault-mocs                                    # list the MOC targets (valid second arg)
vault-profiles                                # explain lean / standard / fat

curator                                       # launch the steward (its default profile: standard)
curator moc-finances                          # steward focused on a domain (moc-* → auto-standard)
reconciler moc-contacts                        # scoped doer on one domain
curator moc-finances --profile fat            # override the profile (the context dial)
curator moc-finances "regenerate the Q2 summary view"   # seed a task
```

Syntax: `<agent> [<target>] [--profile lean|standard|fat] ["task"]`. Under the hood each command runs:

```bash
opencode run -m ollama/qwen3.6-256k --dir . "<rendered briefing>"
```

— OpenCode against **local Ollama over Tailscale**, no API key, no cloud (`SYNAPSE_MODEL` overrides the
model). No `opencode` in PATH? the briefing lands on your clipboard instead, so you can paste it into any
tool.

When you pass a **task**, the launcher routes through `augment.mjs` instead of `render.mjs` (when a
non-empty `note_vectors` index exists), so the briefing gains the labeled "semantically related" section
from the hybrid-retrieval phase above. `--no-semantic` (or `SYNAPSE_SEMANTIC=off`) forces the pure
deterministic render.

### Where are the behavioral gates?

Synapse's `rule-*` library is governance: [[rule-synapse-fail-loudly]], [[rule-no-unprompted-actions]],
[[rule-synapse-human-gated-push]], [[rule-derived-views-are-generated]], … The safety valve is structural:
when an agent hits something it can't safely resolve, it **writes an escalation to `inbox/attention/` with
Options and stops** rather than guessing (Lesson 6). The nightly curator also runs under an OpenCode
**permission config** (read freely; edits and shell gated) — never blanket `--dangerously-skip-permissions`,
which is unsafe for a finances-bearing vault.

> 🤖 **Ask your agent:** *"TUTORIAL.md Lesson 5: render `agent-curator` at lean and at standard with
> `--dry-run`, diff the two closures for me, and explain — by role — why each extra note appears at
> standard (which field pulled it: REFERENCES via `references_docs`, or ATTACHES via `related`)."*

---

## Lesson 6 — the working loop: inbox · migrations · generators · git

Lesson 5 was about how a session *starts*; this is how work **survives between sessions** and how a human
stays in the loop. No chat history required.

### Inbox — where agent work waits for a human

`inbox/` is the human ↔ agent handoff queue, with three lanes:

- **`inbox/attention/`** — escalations. When an agent hits a roadblock it can't safely resolve (ambiguous
  intent, anything destructive, any DB write, from-scratch authoring), it drops a dated note describing
  *what it found*, *why it didn't auto-fix*, and the **Options** for a human to tick — **instead of
  guessing** ([[rule-no-unprompted-actions]], [[rule-synapse-fail-loudly]]). The human ticks; the agent
  reads the resolution next run, completes the work, clears the note.
- **`inbox/curator/logs/`** — the curator's audit trail: a `LOG.md` heartbeat line every pass, plus a
  per-pass note when something happened. A dry night logs one line and exits.
- **`inbox/handovers/`** — clean session handovers ([[rule-context-handover]]).

Raw captures (a phone dump, pasted text, a quick thought) also land in `inbox/`; [[agent-ingester]]
atomizes each into typed notes (or proposed record rows), records `provenance:`, then clears it.

### The maintenance loop — one pass of [[loop-maintain-synapse]]

The curator's standing process detects drift *within* the vault — **there is no external code to chase;
the vault is its own source of truth** ([[doc-maintainer-loop]]). One pass:

1. **Orient** — read `inbox/attention/` + `inbox/curator/logs/` first; action any human-resolved escalation.
2. **Detect** — `lint.mjs --strict`; **DB ↔ derived-view divergence** (a canonical row changed so its view
   is stale, or a generated view was hand-edited); orphans / broken links; `inbox/` items.
3. **Dry gate** — lint `errors=0` AND no divergence AND nothing in the inbox → append `no-op — dry` to
   `LOG.md` and **stop**. The common case; treat as success.
4. **Heal** — mechanical lint autofixes in place; for each drifted unit, dispatch [[agent-reconciler]] to
   regenerate a stale view or make the minimal note edit. Stage only what changed (never `git add -A`).
5. **Verify (maker ≠ checker)** — the curator reviews each reconciler's diff; escalates over-reach.
6. **Escalate** — anything ambiguous/destructive/authoring, or any DB write → an `inbox/attention/` note
   with Options, then stop on it. A record change is proposed as a **migration** in the PR, never applied
   directly.
7. **Re-lint** to `errors=0`; surface any unresolved error loudly. (The pass also refreshes the derived
   projections — `gen-index.mjs`, `gen-views.mjs`, and `gen-embeddings.mjs` for `note_vectors` — so the
   semantic index keeps pace with the notes.)
8. **PR (only if something changed)** — a fresh `synapse/curator-<date>` branch off latest, open a PR. Never
   force-push, never push to the shared branch, never self-merge ([[rule-synapse-human-gated-push]]).
9. **Log** — a heartbeat line.

### The two generators — the substrate projections

| Generator | Direction | Rebuilds |
|---|---|---|
| `node _meta/tools/gen-views.mjs` | **SQL → Markdown** | `contacts/<slug>.md`, `accounts/<slug>.md`, `summary-*` views from canonical rows |
| `node _meta/tools/gen-index.mjs` | **Markdown → SQL** | the `notes` + `note_links` tables (the `.md` index) and `plans` (from plan frontmatter) |
| `node _meta/tools/gen-embeddings.mjs` | **Markdown → SQL** | the `note_vectors` embedding index (semantic recall); incremental — re-embeds only changed notes |

The view/index outputs are `generated: true` and **never hand-edited** — edit the canonical side and
regenerate. `note_vectors` is the same kind of derived projection ([[rule-derived-views-are-generated]]):
it's a rebuildable cache of embeddings, not canonical, gitignored with the DB. The maintainer pass runs
`gen-embeddings.mjs` each cycle so the index stays fresh as notes change — see Lesson 5's hybrid retrieval.

### The migration gate — the only way the DB changes

The DB is never written ad-hoc. A record change is a new file `migrations/NNNN-*.sql`, reviewed in the
same PR diff as any Markdown change, and applied **on merge** by `node _meta/tools/apply-migrations.mjs`
(the only credential that opens `db/synapse.db` read-write). The migration files in git **are** the audit
log and the revert path (revert = a new compensating migration; they're forward-only). Queries and chat
use a **read-only** connection — a generated query can never mutate or drop a table.

### Git — how it all persists

The vault is in-repo and versioned; the `.md` (knowledge + generated views), the manifest, the tooling,
and the **migration files** all live in git. `db/synapse.db` is **gitignored** — it's derived (replayable
from migrations), sensitive, and binary; back it up by file copy. The privacy boundary is the private repo
reachable only over Tailscale — there is no public endpoint.

> 🤖 **Ask your agent:** *"TUTORIAL.md Lesson 6: open `inbox/attention/README.md` and `loops/loop-maintain-synapse.md`,
> walk me through one maintenance pass, and show me exactly where a record change (a new contact) becomes a
> `migrations/NNNN-*.sql` file instead of a direct DB write — and why that delay between propose and apply
> is the feature, not a cost."*

---

## Lesson 7 — hands-on exercises (do these solo, ~20 min)

From the vault root:

1. **Render and read.** `node _meta/tools/render.mjs agent-curator --profile lean`. Find in the output:
   the mission (`purpose`), one rule (CONSTRAINS), and one tool (USES).
2. **Compare profiles, diff by role.** `node _meta/tools/render.mjs agent-curator --profile lean --dry-run`
   (closure 18) vs `--profile standard --dry-run` (closure 24). For each *new* note at standard, name the
   role that pulled it in (REFERENCES via `references_docs`? ATTACHES via `related`?).
3. **Watch auto-upgrade fire.** `node _meta/tools/render.mjs moc-finances --profile lean --dry-run` — note
   the header says `profile=standard` even though you asked for lean. That's the manifest's `autoUpgrade`
   rule for `moc` targets.
4. **Fuse method × domain.** `node _meta/tools/render.mjs agent-reconciler moc-finances --profile standard
   --dry-run` (closure 17) — see the reconciler's rules/tools joined with the finances domain's docs in one
   closure.
5. **Round-trip the SQL index.** `node _meta/tools/apply-migrations.mjs` (applies `0001-init-schema.sql`,
   creating `db/synapse.db`), then `node _meta/tools/gen-index.mjs` (rebuilds `notes` + `note_links` + `plans`
   from the vault), then open the DB **read-only** and query the index — e.g.
   `sqlite3 'file:db/synapse.db?mode=ro&immutable=1' "SELECT id FROM notes WHERE id LIKE 'doc-%' LIMIT 5;"`.
   You just queried the link graph with text-to-SQL.
6. **Lint.** `node _meta/tools/lint.mjs` — read one advisory (an oversize split-candidate) and open the note
   it names. (Don't fix the backlog; just see what it checks.)
7. **Author one knowledge atom.** Pick something the vault doesn't have (an idea → a `note-*`, a structural
   choice → a `decision-*`). Follow `_meta/conventions.md` §1–2 for the frontmatter, and link it from one
   existing note **via a frontmatter `related:` field** so render actually reaches it (a body `[[link]]`
   won't). `node _meta/tools/lint.mjs`. Congratulations — the brain grew.
8. **Propose one record row — the right way.** Want to add a contact? You do **not** write the DB. Create a
   new `migrations/0002-add-<slug>.sql` with the `INSERT`s, leave it for the human-gated PR, and remember
   that on merge `apply-migrations.mjs` runs it and `gen-views.mjs` will produce `contacts/<slug>.md`. Open
   `migrations/0001-init-schema.sql` first to see the table shapes (`money = integer cents`, dates =
   ISO-8601 TEXT, `slug` ties the row to its view).
9. **Try semantic recall — and feed the graph.** One-time on the Ollama host: `ollama pull
   mxbai-embed-large`. Then build the index: `node _meta/tools/gen-embeddings.mjs` (watch it report
   `embedded N`). Now run an augmented briefing with a task that *isn't* about the target's linked
   neighborhood — e.g. `node _meta/tools/augment.mjs agent-curator moc-finances --profile standard --task
   "what do I know about budgeting?"`. Find the appended `## Semantically related (not yet linked)` section
   and note each hit's `similarity` score. Pick one hit that's genuinely relevant and **promote it**: add
   the target id to the relevant note's frontmatter `related:` field (a typed edge), then re-run with
   `--dry-run` to confirm it now appears in the *deterministic* closure — you just turned a fuzzy match into
   a permanent graph edge ([[rule-semantic-suggests-links-decide]]). If Ollama is offline you'll instead see
   `(semantic augment skipped: …)` — proof the deterministic spine never blocks.

> 🤖 **Ask your agent:** *"Walk me through TUTORIAL.md Lesson 7 exercise by exercise — run the commands with
> me, check my answers, and review the note I author in exercise 7 against `_meta/conventions.md` (is the
> link in a frontmatter role field, or only in the body?) and the migration I draft in exercise 8 (am I
> proposing a file, not touching `db/synapse.db`?) before I commit."*

---

## Where to go next

- **Use it daily:** [README](README.md) → *Quick start* and *A day in the life*.
- **Understand the engine:** [[context-engine-guide]] — the plain-language, as-built description of how
  `render.mjs` reads roles and profiles. The manifest itself is `_meta/tools/context.manifest.json` (the
  whole vocabulary in ~30 lines).
- **Add semantic recall:** [[doc-semantic-recall]] (the hybrid-retrieval second phase) ·
  [[rule-semantic-suggests-links-decide]] (additive, labeled, promote-to-link) ·
  [[tool-ollama-embeddings]] (local vectors, no cloud).
- **Author well:** [[conventions]] (naming, edges, the type taxonomy) and the role table in
  [[rule-synapse-edges-by-role]].
- **Understand the architecture:** [[doc-storage-model]] (two substrates, two projections) ·
  [[doc-governance-model]] (read freely, write through one gate) · [[doc-agent-architecture]] (the three
  agents) · [[doc-maintainer-loop]] (the standing loop) · [[doc-sql-schema]] (the records substrate).
- **Understand the why:** the ADRs — [[decision-0003-human-gated-mutation]],
  [[decision-0004-opencode-local-ollama-runtime]] — short records of every structural choice.
- **See it run:** [[loop-maintain-synapse]] owned by [[agent-curator]], on the OpenCode + local Ollama
  runtime.

> 🤖 **The full tour, one prompt:** *"Read TUTORIAL.md end to end and be my tour guide: for each lesson give
> me the 2-minute version with one live demonstration from this vault (run the real command), quiz me with
> one question, and only move on when I get it right."*
</content>
</invoke>
