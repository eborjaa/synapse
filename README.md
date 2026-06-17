# 🧠 Synapse — a manifest-driven context vault

> **Your private second brain that an LLM reads from and writes to** — Markdown for knowledge, SQLite for
> records, one ontology, and an agent that keeps it healthy. One graph you point any AI tool at so you
> never re-explain yourself. Deterministic, typed-graph briefings — plus an opt-in **semantic recall**
> layer (local embeddings) that surfaces conceptually-related notes you never explicitly linked. Runs
> entirely on hardware you control.

> 👋 **New here? Open [`moc-synapse`](moc-synapse.md)** — the master hub. Then read the box below.
> **Tuning agents or domain hubs?** Every `agent-*` and `moc-*` name below is a **clickable link to the
> file you edit.**

Synapse is **LLM-agnostic and data-agnostic**: nothing here is tied to a particular model vendor or a
particular person's data. The engine and conventions describe a *shape* you fill with your own. The
reference runtime is **[OpenCode](https://opencode.ai) pointed at a local Ollama model over Tailscale** —
no API key, no cloud, no subscription in the core loop. The runtime is **pluggable**: the same briefing can
be handed to OpenCode (default), Claude Code, your clipboard, or stdout via `--cli` (see below), so you can
maintain the public framework with one CLI and a private vault with another.

---

## 🚀 Install (one-time) — wire up the CLI

```bash
cd /path/to/wiki
# Option A — preview, then apply: sources agents.sh in your shell rc + wires the OpenCode runtime
node _meta/tools/install.mjs            # dry-run: prints exactly what it WOULD add, changes nothing
node _meta/tools/install.mjs --write    # apply (idempotent — safe to re-run)

# Option B — just source the CLI for this shell (no rc edit)
source "_meta/tools/agents.sh"

exec $SHELL                             # reload your shell
vault-agents                            # ← you now have one command per agent
```

> The installer bakes the absolute vault path into the source line and appends a short Synapse pointer to
> your OpenCode instructions. It never touches your model config or any secret — your endpoint, model,
> and (absence of a) key live in `~/.config/opencode/opencode.json`, which Synapse never reads or writes.

```bash
# Optional — enable semantic recall (the opt-in second retrieval phase, see below):
ollama pull mxbai-embed-large          # one-time, on the Ollama host that serves your model
node _meta/tools/gen-embeddings.mjs    # build db/synapse.db's note_vectors index (the maintainer keeps it fresh)
```

## ⚡ Quick start — the CLI is the primary tool

Type an agent's name, point it at a target, optionally describe a task. The agent launches **with the full
briefing** (mission + rules + skills + the target's neighborhood) compiled deterministically — no
copy-paste:

```bash
vault-agents                                    # list every agent command + what it's for
vault-mocs                                       # list all MOC targets (the master + 7 domain hubs)
vault-profiles                                   # explain the context dial

curator                                          # run the steward at its default profile
curator moc-finances                             # steward, scoped to one domain hub (moc-* → auto-standard)
reconciler moc-contacts                          # fix one drifted domain's notes/views
curator moc-finances "regenerate the Q2 summary view"   # seed a concrete task
oracle moc-finances "did I note anything about budgeting?"   # ask the vault — read-only, cited, +semantic recall
```

> Supplying a **task** auto-routes the command through the semantic augment (when the embedding index
> exists), so the briefing also carries notes the typed graph never linked. See **Semantic recall** below.

**Syntax:** `<agent> [<target>] [--profile lean|standard|fat] ["task"]`. A `moc-*` target auto-upgrades a
`lean` agent to `standard`; a bare profile word also works (`curator moc-finances fat`). No `opencode` in
PATH? the briefing lands on your clipboard instead, paste-ready for any tool.

---

## 🧠 The model — what a command actually does

Each command **renders a briefing** by combining three things, then hands it to OpenCode (or your
clipboard). Same shape every time:

| You pick… | = | What it is | Examples |
|---|:--:|---|---|
| **① an Agent** | the **method** (what *job*) | mission + rules + skills + tools | `curator` · `reconciler` · `ingester` · `oracle` |
| **② a Target** | the **what** (which *domain/unit*) | the knowledge to act on | `moc-finances` · `moc-contacts` · a note `id` |
| **③ a Profile** | the **dial** (how *much* context) | which relationship roles to pull | `lean` · `standard` · `fat` |

The render is **deterministic**: same inputs → byte-identical briefing, so agent runs are reproducible.
Nothing domain-specific is hardcoded — point the same engine at a different manifest and it runs a
different vault unchanged.

### ③ Profiles — the context dial

Profiles are presets of relationship **roles** to traverse (not raw hop counts):

| Profile | Roles pulled | ~Budget | Best for |
|---|---|:--:|---|
| **`lean`** | self + rules/skills/tools/delegations | ~4K tok | an agent + its method, or a single unit note |
| **`standard`** | + members, attachments, navigations, refs | ~15K tok | a domain **MOC** (pulls its members + refs) |
| **`fat`** | + the transitive closure | ~30K tok | deep dives / maximum context |

> **Rule of thumb:** agents → their declared profile; domain MOCs → `standard`. Any `moc-*` target
> auto-upgrades to `standard`. `--dry-run` previews the closure (node counts) without pulling bodies.

---

## 🤖 ① Agents — pick the job (4: three writers + one reader)

> **Click an agent name to open its file** (`agents/agent-*.md`) — `purpose`, `applies_rules`,
> `invokes_skills`, `profile`, `delegates_to`. That's where you tune behavior. **Maker ≠ checker:** the
> agent that writes an edit never approves it.

| Job | Agent — *click to open & edit* | Default profile | Typical target |
|---|---|:--:|---|
| 🧹 Steward — detect drift, heal the unambiguous, dispatch + verify, open one human-gated PR | [`agent-curator`](agents/agent-curator.md) | standard | `loop-maintain-synapse` / a `moc-<domain>` |
| 🔧 Scoped doer — reconcile ONE drifted unit against its canonical source (no PR, no DB write) | [`agent-reconciler`](agents/agent-reconciler.md) | standard | a `moc-<domain>` |
| 📥 Capture ingester — atomize one `inbox/` dump into typed notes + proposed migration rows | [`agent-ingester`](agents/agent-ingester.md) | standard | an `inbox/` item |
| 🔮 Oracle — read-only Q&A: answer grounded in a MOC's closure + semantic recall, cite sources, propose consent-gated handoffs | [`agent-oracle`](agents/agent-oracle.md) | standard | a `moc-<domain>` + a question |

The first three **write** (maker ≠ checker, every change a human-gated diff); the oracle only **reads**.

**Which agent for which task** — route by three axes: *read vs write*, *new input vs existing drift*, *one
unit vs sweep + PR*:

- **A question — retrieve / explain** → **oracle** (read-only): a grounded, cited answer over the
  `moc-<domain>` closure + semantic recall; never writes, and proposes a consent-gated handoff if it spots
  a gap.
- **New raw input to file / atomize** → **ingester**: atomizes an `inbox/` dump into typed notes + proposed
  rows; if no existing domain fits, it **proposes a new `moc-<domain>`** hub in the same human-gated proposal.
- **One existing note/view drifted from its source** → **reconciler** (scoped; no PR; never authors from
  scratch).
- **Whole-vault sweep / verify others' diffs / open the PR** → **curator** (steward).

A planning **lead** (decompose a multi-step goal, delegate to the writers) can be added later; the core loop
needs only curator + reconciler + ingester, with the oracle answering on demand alongside them. See
[`doc-agent-architecture`](docs/doc-agent-architecture.md).

---

## 🗂️ MOC architecture — the hub-and-spoke graph

Synapse is organized as one **master hub** that links out to **domain hubs**, each of which gathers its own
notes and records as *members*. You navigate down through hubs; members roll up automatically.

```
                              [[moc-synapse]]   ← master hub: architecture · domains · method
                                   │
   ┌──────────┬───────────┬────────┼────────┬───────────┬────────────┬──────────────┐
moc-finances moc-contacts moc-health moc-places moc-journal moc-projects moc-social-media
   │            │           │           │          │            │              │
(accounts,  (contact     (health    (places,   (journal-*   (project-*,   (post drafts,
 summaries)  views,       summaries) visits,     entries)    plan-*)       published notes,
             person notes)           geo summaries)                        engagement summaries)
```

- **Master hub — [`moc-synapse`](moc-synapse.md):** the front door. Links the architecture docs, the seven
  domain hubs, and the method layer (agents, loop, schema, engine).
- **Seven domain hubs (`moc/moc-*.md`):** one map per domain —
  [[moc-finances]] · [[moc-contacts]] · [[moc-health]] · [[moc-places]] · [[moc-journal]] · [[moc-projects]] ·
  [[moc-social-media]]. Each domain hub itself declares `related: ["[[moc-synapse]]"]`, so it *navigates* up
  to the master.

### How membership works — reverse-BINDS

A hub never lists its members by hand. Instead, **a note's `related: ["[[moc-x]]"]` makes that note a
member of `moc-x`** — the render engine follows the `BINDS` role in *reverse* (`related` → `members`) for
any `note` / `journal` / `project` / `plan` / `contact` / `account` / `summary` endpoint. So:

- You add a `journal-2026-06-15.md` with `related: ["[[moc-journal]]"]` → it shows up under
  [[moc-journal]]'s members on the next render. No edit to the hub.
- A `summary-finances-2026-q2.md` with `related: ["[[moc-finances]]"]` → it rolls up under
  [[moc-finances]].

> The domain hubs are **intentionally near-empty until data lands**. `render.mjs --lint` reports
> `members>=1` for empty `standard` MOCs — that report is **by design and expected** while you bootstrap.
> See [`_meta/conventions.md`](_meta/conventions.md) §3 (links are typed edges; the field decides the role).

---

## 🔎 Semantic recall — the opt-in second phase

The render engine is **deterministic**: it follows *typed links*, so it only reaches what you explicitly
connected. Semantic recall adds the missing half — **embedding-based search** that finds conceptually
related notes across the whole vault, regardless of links or wording. This is classic **hybrid retrieval**
(graph + vector), split into two clean phases:

- **Phase 1 — deterministic seed (unchanged).** `render.mjs` walks the typed-link closure → a
  byte-identical briefing. Pure, offline, reproducible. Nothing here changes.
- **Phase 2 — semantic augment (new, opt-in).** `augment.mjs` embeds the **task**, cosine-ranks notes
  **not already in the closure**, drops anything below a similarity floor, and appends a clearly-labeled
  `## Semantically related (not yet linked)` section of short excerpts.

**All local, no new deps.** Embeddings come from the **same local Ollama over Tailscale** that runs the
agents — no API key, no cloud. Default model `mxbai-embed-large` (1024-dim; override with
`SYNAPSE_EMBED_MODEL`). Vectors are stored as BLOBs in a generated `note_vectors` table in `db/synapse.db`
— a derived projection (rebuildable, gitignored, never canonical). Cosine is computed in JS; `sqlite-vec`
is the documented scale-up path.

**The boundary that keeps it safe.** Semantic results are **additive, labeled, and non-authoritative**:
the deterministic briefing stays the spine, a similarity hit never silently drives a mutation, and when a
hit is genuinely relevant the agent **promotes it to a typed `related:` link**. So semantic discovery
*feeds the deterministic graph* — the vault grows more precise the more it's used. If Ollama is unreachable
or the index is empty, augment still emits the full deterministic briefing plus a skip note.

→ Full detail: [`doc-semantic-recall`](docs/doc-semantic-recall.md) ·
[`rule-semantic-suggests-links-decide`](rules/rule-semantic-suggests-links-decide.md) ·
[`tool-ollama-embeddings`](tools/tool-ollama-embeddings.md) ·
[`decision-0005-hybrid-retrieval`](_meta/decisions/decision-0005-hybrid-retrieval.md).

---

## 🛠️ Full command reference

Everything runnable, in one place. Two front-ends over the same `_meta/tools/` scripts.

**A. Shell CLI** — source once (`agents.sh` via the installer), then call agents by name:

| Command | Does |
|---|---|
| `<agent> [<target>] [--profile lean\|standard\|fat] [--cli opencode\|claude\|clip\|print] ["task"]` | render the agent (+ optional target) briefing → hand it to the chosen runtime seeded with it. e.g. `curator moc-finances standard "rebuild summaries"` |
| `vault-agents` | list all agents + purpose + default profile |
| `vault-mocs` | list all MOC targets (the master + 7 domain hubs) |
| `vault-profiles` | explain `lean` / `standard` / `fat` (the context dial) |

> **The runtime is pluggable (`--cli`).** The same rendered briefing can be handed to a swappable sink:
> **`opencode`** (default — local Ollama over Tailscale), **`claude`** (Claude Code, scoped to the repo dir,
> its own model/keys/config), or **`clip`** / **`print`** (copy to clipboard / write to stdout, paste or
> pipe into any tool). The render + semantic pipeline is identical for every sink — so you can maintain the
> **public framework** with a powerful cloud CLI while a **private vault** stays on local OpenCode, using the
> same commands (set a default with `export SYNAPSE_CLI=…`). Any host privacy gate still applies to whichever
> CLI you launch.
>
> Model is one env var: `export SYNAPSE_MODEL=ollama/<your-model>` (default `ollama/qwen3.6-256k`). Endpoint
> + key (there is none) live in `~/.config/opencode/opencode.json`. That single line is what keeps Synapse
> LLM-agnostic.
>
> In an interactive terminal, an agent opens the **OpenCode TUI** seeded with the briefing — you get its
> native progress spinner + token counter and stay in a live session to keep working with the agent. With
> no TTY (cron/pipes) it falls back to one-shot `opencode run`. Override with `SYNAPSE_TUI=1` (force TUI) or
> `SYNAPSE_TUI=0` (force one-shot). In one-shot mode, a local reasoning model can sit silent for 30–90s
> while it processes a multi-thousand-token briefing, so reasoning is streamed as proof-of-life; set
> `SYNAPSE_THINKING=0` to hide it and print only the final answer.

**B. Direct `node`** (no shell setup) — drive the engine scripts yourself:

```bash
# Render an agent (+ optional target) briefing to stdout:
node _meta/tools/render.mjs agent-curator moc-finances --profile standard

# Copy a briefing to the clipboard for paste into any AI tool:
node _meta/tools/render.mjs agent-reconciler moc-contacts --copy

# Dry-run: closure node-counts only, no bodies pulled:
node _meta/tools/render.mjs moc-synapse --profile standard --dry-run

# Validate manifest invariants across the whole index (CI-style; never writes):
node _meta/tools/render.mjs --lint

# Health-check the vault (errors fail; --strict also fails on broken links / fences):
node _meta/tools/lint.mjs
node _meta/tools/lint.mjs --strict

# Records substrate — the ONLY writer of the DB (gated through migration files):
node _meta/tools/apply-migrations.mjs --status     # list applied / pending, apply nothing
node _meta/tools/apply-migrations.mjs              # apply pending migrations on merge

# Regenerate the SQL projections of Markdown (the .md link-index + the plans table):
node _meta/tools/gen-index.mjs                     # rebuild notes + note_links + plans

# Regenerate the Markdown projections of SQL (read-only views; never hand-edited):
node _meta/tools/gen-views.mjs                     # write contacts/, accounts/, finance summaries

# Semantic recall — build the embedding index (derived projection; gitignored with the DB):
ollama pull mxbai-embed-large                      # one-time, on the Ollama host
node _meta/tools/gen-embeddings.mjs                # incremental: embed new/changed notes → note_vectors
node _meta/tools/gen-embeddings.mjs --all          # force a full re-embed

# Use it directly — deterministic briefing + the labeled "semantically related" section:
node _meta/tools/augment.mjs agent-curator moc-finances --profile standard --task "did I note anything about budgeting?"
node _meta/tools/augment.mjs agent-curator moc-finances --profile standard --task "..." --k 8   # more hits
node _meta/tools/augment.mjs agent-curator moc-finances --profile standard --task "..." --no-semantic  # render only
```

> Any vault `<id>` is a valid render target — not just MOCs. Render a single agent, rule, doc, or note
> directly for the tightest context.

---

## 🔁 A day in the life

**Capture → ingest → review** (the inbound path):
```bash
# 1. Dump a freeform thought into inbox/ (zero friction — no schema, no decision).
echo "called the plumber, $180, fixed the leak" >> inbox/2026-06-15.md

# 2. Atomize it into typed notes + proposed migration rows (records ride a migration file).
ingester inbox/2026-06-15.md

# 3. Review the diff the agent opened as a PR; you merge → migrations apply, views regenerate.
```

**Render the curator → run a maintenance pass** (the outbound / upkeep path):
```bash
curator                                          # 1. orient + detect drift across the vault
curator moc-finances "summaries look stale"      # 2. scope a pass to one domain with a task (auto-adds semantic recall)
node _meta/tools/lint.mjs --strict               # 3. confirm the vault is schema-clean
```

> Because step 2 carries a task, the briefing also gets a labeled `## Semantically related (not yet
> linked)` section — notes the typed graph didn't reach. Force it off with `--no-semantic`.

Or hand the briefing to any tool without a shell setup:
```bash
node _meta/tools/render.mjs agent-curator loop-maintain-synapse --profile standard --copy
```

---

## 🧩 The two substrates + the gate (in brief)

Synapse stores knowledge and records in **two substrates joined by one ontology**, and **records never
mutate unattended**:

- **Markdown-in-Git** — canonical for *knowledge* (notes, journal, plans, projects, people-narrative,
  decisions). Human-readable, linkable, versioned.
- **Local SQLite** — canonical for *records* (contacts, accounts, transactions, health, places). Queried
  **read-only**; the file is gitignored (derived, sensitive, binary).
- **Where they meet,** one side is canonical and the other is a *generated, never-hand-edited* projection:
  SQL rows project to read-only Markdown views; Markdown notes project to a SQL link-index.

**Governance is per-repo and per-content** — the agent detects which repo and what content type, then
applies the matching gate ([`decision-0006-self-healing-vault`](_meta/decisions/decision-0006-self-healing-vault.md)):

- **Framework repo — fully PR-gated.** Every change rides a PR; the agent opens a fresh branch and **never**
  pushes to `main` directly, **never** force-pushes, and **never** self-merges. A maintainer reviews and
  (with approvals required) admin-bypasses to merge. Maker ≠ checker holds.
- **Private vault, Markdown/knowledge — self-healing.** The steward commits and pushes verified
  Markdown/knowledge **directly**, no PR — git history is the audit trail and revert path.
- **Records/DB — human-gated everywhere, including the vault.** SQLite changes ride **migration files**
  through the human gate on every repo; a runner applies them on merge. The self-healing autonomy never
  extends to the records DB, because finances are in scope.

→ Full detail: [`doc-storage-model`](docs/doc-storage-model.md) · [`doc-governance-model`](docs/doc-governance-model.md) · [`doc-agent-architecture`](docs/doc-agent-architecture.md).

---

## 🔐 The privacy gate — framework readable, vault sealed

Synapse's intended deployment is **one parent directory holding two repos as siblings** — the public
`synapse-framework/` and your private `synapse-vault/`. The whole point: you can point a capable **external
coding agent** (e.g. Claude Code) at the parent to read and maintain the framework while it is *structurally
incapable* of touching the vault.

- **A single, fail-closed, path-based `PreToolUse` hook** — configured at the host level (e.g. in
  `~/.claude/settings.json`), outside either repo — denies any read/edit/write/search whose path resolves
  inside the vault, and any shell command that references the vault path.
- **Default ON.** The hook checks a **host sentinel** (a file outside either repo); with no sentinel, the
  gate is live and the vault is sealed. The owner can deliberately toggle it off for a scoped task — e.g. to
  let a more capable CLI maintain the vault directly via `--cli claude` — then re-seal. Default ON means a
  forgotten step fails *closed*.
- **The only seam** that crosses into the sealed vault is a clean, one-directional `git fetch` / `merge` /
  `pull … upstream` — so the framework can pull upstream updates *into* the vault without ever exposing its
  contents. The gate constrains **only** the external agent; your local model, Obsidian, and the engine
  scripts touch the vault at full fidelity.

→ Full detail: [`doc-deployment-gate`](docs/doc-deployment-gate.md) · [`doc-runtime-wiring`](docs/doc-runtime-wiring.md).

---

## 🪟 Obsidian (browse the graph)

Open the **repo root** as an Obsidian vault (`node_modules`, `db/`, `_meta/logs/` excluded via
`.obsidian/app.json`). Nodes are color-coded by `#type/<type>` (configured in `.obsidian/graph.json`):

| 🟡 moc | 🔴 agent | 🟠 loop | 🔵 rule | 🟣 skill | ⚪ tool | 🩶 doc |
|---|---|---|---|---|---|---|
| 🫒 decision | 🟢 note | 🩵 journal | 🌊 plan | 🌿 project | 🌸 person | 🧡 contact / account | 🟨 summary |

---

## 🧹 Staying healthy

- **Local check:** `node _meta/tools/lint.mjs` (advisory) · `--strict` (the CI-style gate: also fails on
  broken links + unbalanced fences).
- **Pre-commit hook (opt-in):** `ln -sf ../../_meta/tools/pre-commit.sh .git/hooks/pre-commit`.
- **Nightly curator (local cron):** `_meta/tools/maintain-synapse-cron.sh` runs the steward headlessly via
  OpenCode against local Ollama — detect drift → heal the unambiguous → escalate the rest → open a
  human-gated PR → log. A "dry" night (nothing to do) just appends a heartbeat and counts as success. It
  runs under a constrained OpenCode permission posture (read freely; edits/shell gated), never
  `--dangerously-skip-permissions`, and never self-merges. Install with `crontab -e` or a launchd agent
  (see the header of that script).

## ➕ Extending

- **New note?** → pick the right `type` from [`_meta/conventions.md`](_meta/conventions.md) §5, give it a
  unique kebab `id` (filename = `id`, prefix implies `type`), required frontmatter (`id`/`type`/`title`/
  `tags` with block-style `- type/<type>`), and `related: ["[[moc-<domain>]]"]` so it rolls up.
- **New convention/rule?** → add `rule-*.md`; wikilink it from the relevant agents' `applies_rules`.
- **New agent job?** → add `agent-*.md` (`purpose` + `applies_rules` + `invokes_skills` + `profile`); the
  shell CLI auto-discovers it on the next `source`.
- **New domain MOC?** → add `moc/moc-<domain>.md` (`type: moc`, block-style tags, `related: ["[[moc-synapse]]"]`,
  `references_docs` to the docs it cites); link it from [`moc-synapse`](moc-synapse.md)'s Domains section.
- **New record migration?** → add a forward-only file under `migrations/`; it rides the same PR gate and
  doubles as the audit log + revert path. Apply with `apply-migrations.mjs` on merge.

Always: unique kebab basenames, frontmatter + type per [`_meta/conventions.md`](_meta/conventions.md),
bare `[[basename]]` links in the right role-field, then `lint.mjs --strict`.

See [`_meta/conventions.md`](_meta/conventions.md) (schema + type taxonomy) ·
[`context-engine-guide`](_meta/tools/context.manifest.json) (the manifest) ·
[`_meta/tools/agents.sh`](_meta/tools/agents.sh) (the CLI).

---

## 🌱 Getting started (use this template)

Synapse is a GitHub **Template repo** — you don't fork it, you *instantiate* it as your own vault.

1. **Use this template / clone.** Click **"Use this template"** on GitHub (or `git clone` it), then open
   the new repo as your private vault.
2. **Prerequisites.**
   - **Node 22+** (the engine uses Node's built-in `node:sqlite` — no native deps).
   - **OpenCode** (`opencode-ai`) on PATH — the agent runtime.
   - **Ollama** reachable (local or over Tailscale) — the model + embedding server.
   - `ollama pull mxbai-embed-large` — the default embedding model for semantic recall
     (override with `SYNAPSE_EMBED_MODEL`).
3. **Wire the CLI.** `node _meta/tools/install.mjs` (dry-run — prints what it would change), then
   `node _meta/tools/install.mjs --write` (idempotent). `exec $SHELL` to reload.
4. **Create the records DB.** `node _meta/tools/apply-migrations.mjs` applies `0001-init-schema.sql` →
   a fresh `db/synapse.db` (gitignored, replayable from migrations).
5. **Make it yours.**
   - **Set your name** for the nightly canary: `export VAULT_USER="Your Name"` (it falls back to
     `git config user.email`, then a generic default).
   - **Record ownership** in the DB: copy `migrations/0002-owner.sql.example` →
     `migrations/0002-owner.sql`, fill in your name/handle/date, then `apply-migrations.mjs` again.
6. **Start capturing.** Append freeform thoughts to `inbox/`, then let `ingester` atomize them into typed
   notes and proposed migration rows. See **A day in the life** above.

## 🔱 Two-repo model — framework vs. your vault

Synapse is a **framework**; your knowledge is a **separate, private instance** of it.

- **The public repo (this one) is the framework:** the render engine, conventions, governance rules,
  agents, loop, docs, and the starter SQL schema. It ships **no personal data**.
- **Your vault is a private repo** whose **`origin` is private** (your data) and whose **`upstream` is this
  public repo**. Pull framework updates with:

  ```bash
  git remote add upstream https://github.com/<owner>/synapse.git   # one-time
  git fetch upstream && git merge upstream/main                     # pull framework updates
  ```

  **Never push your vault to `upstream`.** Contribute framework fixes back via a PR from a clean,
  data-free branch (see [`CONTRIBUTING.md`](CONTRIBUTING.md)).

**The boundary is by directory:**

| Upstream-owned (framework) | Yours (instance) |
|---|---|
| `_meta/` (engine, manifest, tools, rules), `agents/`, `loops/`, `docs/`, `rules/`, `skills/`, `tools/`, `migrations/0001-init-schema.sql` | `inbox/`, `notes/`, `journal/`, `projects/`, `plans/`, `people/`, your `db/`, your domain MOCs, your `0002+` migrations, your custom rules |

→ Full detail (the two-layer architecture, as a vault note): [`doc-fork-and-extend`](docs/doc-fork-and-extend.md).

---

## 🙏 Acknowledgments

Synapse builds on ideas and tooling from others — credited here for what it genuinely uses or is
inspired by:

**Special thanks to [@JavierCorado](https://github.com/JavierCorado)** — for teaching me and inspiring me
to develop this.

- **Andrej Karpathy — the ["LLM Wiki" gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)** —
  the seed idea Synapse realizes: an LLM incrementally maintaining a persistent, interlinked Markdown
  knowledge base as a *compiled artifact* that grows richer with each source, with the human curating and asking.
- **The loop-engineering pattern** — "run-until-dry" maintenance (detect → heal → verify, repeat until a
  pass is dry), which the nightly maintainer loop ([`loop-maintain-synapse`](loops/loop-maintain-synapse.md)) implements.
- **[OpenCode](https://opencode.ai)** — the local, config-driven agent runtime.
- **[Ollama](https://ollama.com)** — local models + embeddings (`mxbai-embed-large` by default).
- **[Obsidian](https://obsidian.md)** — graph browsing + Markdown editing over the vault.
- **Node's built-in SQLite (`node:sqlite`)** — the records substrate, with no native dependency.
- **Reciprocal Rank Fusion (RRF)** — the hybrid-retrieval technique that fuses the deterministic graph
  closure with embedding-similarity hits; **[`sqlite-vec`](https://github.com/asg017/sqlite-vec)** is the
  noted scale-up path beyond brute-force cosine.
- **[MemPalace](https://github.com/MemPalace/mempalace)** — a local-first AI memory system; studying it
  shaped Synapse's hybrid semantic-recall design. Worth a look for a complementary, recall-first take.

See also [`CREDITS.md`](CREDITS.md).

## License

[MIT](LICENSE) © 2026 Emmanuel Borja. Use the pattern with any model and any data.
