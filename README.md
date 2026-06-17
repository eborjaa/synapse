# 🧠 Synapse — a context vault for the LLM age

> **One private knowledge graph you point any AI tool at — so you never re-explain yourself.**
> Markdown for knowledge, SQLite for records, one ontology, and an agent that keeps it healthy.
> Runs entirely on hardware you control.

---

## The problem it solves

We live in an LLM world, and every tool starts from zero. You paste the same context into ChatGPT,
then again into Claude, then again next week — your knowledge scattered across chat logs, notes apps,
and your own memory. The models are powerful; the **context** is the bottleneck.

Synapse is the fix: a single, typed knowledge graph that lives on your machine and that *any* AI tool
can read from and write to **through a reviewable gate**. Capture once, link it, and every future
question — in any CLI — starts with the full picture. Your second brain, version-controlled and yours.

**What it is, concretely:**

- **Markdown-in-Git** is canonical for *knowledge* (notes, journal, plans, projects, people).
- **Local SQLite** is canonical for *records* (contacts, accounts, finances, health, places) — queried read-only.
- **One ontology** joins them; generated projections keep both sides in sync without duplication.
- **An agent keeps it healthy** — detecting drift and proposing every change as a diff a human merges.
- **LLM- and data-agnostic.** Nothing is tied to one model vendor or one person's data. The reference
  runtime is **[OpenCode](https://opencode.ai)** on a local **[Ollama](https://ollama.com)** model over
  Tailscale — no API key, no cloud, no subscription in the core loop.

---

## Contents

[Quick start](#-quick-start) · [Your first commands](#-your-first-commands) ·
[Ask the vault + semantic recall](#-ask-the-vault--semantic-recall) ·
[Pluggable runtime (`--cli`)](#-pluggable-runtime---cli) · [A day in the life](#-a-day-in-the-life) ·
[How it works](#-how-it-works-in-brief) · [Get started (template)](#-get-started-use-this-template) ·
[More](#-more)

---

## 🚀 Quick start

```bash
cd /path/to/your-vault
node _meta/tools/install.mjs            # dry-run: print what it WOULD add, changes nothing
node _meta/tools/install.mjs --write    # apply (idempotent — safe to re-run)
# open a new terminal (or 'exec $SHELL') to pick up the new PATH
vault-agents                            # ← verify all commands are on PATH
```

> The installer is **shell-agnostic**: detects fish, bash, or zsh and writes the correct PATH line to your
> shell config. It generates standalone launcher scripts in `_meta/tools/bin/` — each a tiny bash wrapper
> around the core `agents.sh` logic — so the commands work from any shell without sourcing anything. It also
> appends a short Synapse pointer to your OpenCode instructions. It never touches your model config or any
> secret. No `opencode` on PATH? a briefing lands on your clipboard instead, paste-ready for any tool.

## ⚡ Your first commands

Type an agent's name, point it at a target, optionally describe a task. The agent launches **with the full
briefing** (mission + rules + skills + the target's neighborhood) compiled deterministically — no copy-paste:

```bash
curator                                          # run the steward — detect drift across the vault
curator moc-finances                             # scope it to one domain hub
oracle moc-finances "did I note anything about budgeting?"   # ask the vault — read-only, cited
reconciler moc-contacts                          # fix one drifted domain's notes/views
ingester inbox/2026-06-15.md                     # atomize a freeform capture into typed notes + rows
```

**Syntax:** `<agent> [<target>] [--profile lean|standard|fat] ["task"]`. A `moc-*` target auto-upgrades a
`lean` agent to `standard`. → **Full command reference, env vars & flags:** [`doc-cli-reference`](docs/doc-cli-reference.md).

---

## 🔮 Ask the vault + semantic recall

The **oracle** answers questions grounded in your vault — read-only, every claim cited back to the note
that owns it, never a fabrication:

```bash
oracle moc-finances "what did I decide about the emergency fund?"
```

What makes the answer *good* is **semantic recall** — an opt-in second retrieval phase. The render engine
is deterministic: it follows *typed links*, so it only reaches what you explicitly connected. Semantic
recall adds the missing half — **embedding-based search** that finds conceptually-related notes across the
whole vault, regardless of links or wording, and appends them under a clearly-labeled
`## Semantically related (not yet linked)` section. This is classic **hybrid retrieval** (graph + vector).

**Turn it on (all local, no new deps):**

```bash
ollama pull mxbai-embed-large          # one-time, on the Ollama host that serves your model
node _meta/tools/gen-embeddings.mjs    # build db/synapse.db's note_vectors index (the maintainer keeps it fresh)
```

Embeddings come from the **same local Ollama** that runs the agents — no API key, no cloud. Results are
**additive, labeled, and non-authoritative**: a similarity hit never silently drives a change, and when a
hit is genuinely relevant the agent **promotes it to a typed `related:` link** — so semantic discovery
*feeds the deterministic graph*, and the vault grows more precise the more you use it.

→ Full detail: [`doc-semantic-recall`](docs/doc-semantic-recall.md) ·
[`rule-semantic-suggests-links-decide`](rules/rule-semantic-suggests-links-decide.md) ·
[`tool-ollama-embeddings`](tools/tool-ollama-embeddings.md).

## 🔌 Pluggable runtime (`--cli`)

OpenCode is the **default** runtime, not the only one. The *same* rendered briefing can be handed to a
swappable sink with `--cli` — so you can drive Synapse with whatever tool you like:

```bash
curator moc-finances "rebuild summaries"                  # → OpenCode (default, local Ollama)
curator moc-finances "rebuild summaries" --cli claude     # → Claude Code, scoped to the repo dir
oracle moc-health "trend since April?"   --cli clip       # → copy the briefing to the clipboard
reconciler moc-contacts                  --cli print      # → write the briefing to stdout, pipe anywhere
```

The render + semantic pipeline is identical for every sink — only the final hand-off differs. That's the
whole trick: maintain the **public framework** with a powerful cloud CLI while a **private vault** stays on
local OpenCode, using the same commands. Set a default with `export SYNAPSE_CLI=…`; pick your model with
`export SYNAPSE_MODEL=ollama/<your-model>`.

→ Full detail: [`doc-runtime-wiring`](docs/doc-runtime-wiring.md) · all sinks, env vars & TUI behavior in
[`doc-cli-reference`](docs/doc-cli-reference.md).

---

## 🔁 A day in the life

Follow one thought through the whole system:

```bash
# 1. CAPTURE — dump a freeform thought into inbox/ (zero friction: no schema, no decision).
echo "called the plumber, \$180, fixed the leak" >> inbox/2026-06-15.md

# 2. INGEST — atomize it into typed notes + proposed migration rows (records ride a migration file).
ingester inbox/2026-06-15.md          # opens a PR you review; on merge, migrations apply + views regenerate

# 3. ASK — later, query the vault; semantic recall surfaces notes you never explicitly linked.
oracle moc-finances "how much have I spent on home repairs?"

# 4. MAINTAIN — the steward keeps the graph schema-clean and the views current.
curator moc-finances "summaries look stale"     # detect → heal the unambiguous → escalate the rest → PR
node _meta/tools/lint.mjs --strict              # confirm the vault is schema-clean
```

That's the loop: **capture freely → the agent structures it → ask anything → an agent keeps it healthy** —
every write a reviewable diff, nothing applied unattended.

---

## 🧠 How it works (in brief)

**Every command renders a briefing** by combining three things, then hands it to your chosen runtime. The
render is **deterministic**: same inputs → byte-identical briefing, so agent runs are reproducible.

| You pick… | = | What it is | Examples |
|---|:--:|---|---|
| **① an Agent** | the **method** (what *job*) | mission + rules + skills + tools | `curator` · `reconciler` · `ingester` · `oracle` |
| **② a Target** | the **what** (which *domain/unit*) | the knowledge to act on | `moc-finances` · a note `id` |
| **③ a Profile** | the **dial** (how *much* context) | `lean` (~4K) · `standard` (~15K) · `fat` (~30K) | which relationship roles to pull |

**The four agents** — three writers + one reader. *Maker ≠ checker:* the agent that writes an edit never
approves it. Click a name to open and tune its file.

| Agent | Job |
|---|---|
| 🧹 [`agent-curator`](agents/agent-curator.md) | **steward** — detect drift, heal the unambiguous, dispatch + verify, open one human-gated PR |
| 🔧 [`agent-reconciler`](agents/agent-reconciler.md) | **scoped doer** — reconcile ONE drifted unit against its source (no PR, no DB write) |
| 📥 [`agent-ingester`](agents/agent-ingester.md) | **capture** — atomize one `inbox/` dump into typed notes + proposed migration rows |
| 🔮 [`agent-oracle`](agents/agent-oracle.md) | **reader** — grounded, cited Q&A over a domain's closure + semantic recall (never writes) |

**The graph is hub-and-spoke.** One master hub links out to seven domain hubs; members roll up
automatically (a note's `related: ["[[moc-x]]"]` *makes* it a member of `moc-x` — the hub is never edited
by hand).

```
                          [[moc-synapse]]   ← master hub: architecture · domains · method
                               │
   ┌──────────┬───────────┬────┼────┬───────────┬────────────┬──────────────┐
moc-finances moc-contacts moc-health moc-places moc-journal moc-projects moc-social-media
```

**Two substrates, one gate.** Markdown is canonical for knowledge, SQLite for records; where they meet,
one side is canonical and the other is a *generated, never-hand-edited* projection. **Records never mutate
unattended** — every DB change rides a migration file through a human gate. Governance is per-repo: the
framework is fully PR-gated, vault Markdown self-heals, and the records DB is gated everywhere.

→ Deeper: the in-vault map [`moc-synapse`](moc-synapse.md) · [`doc-agent-architecture`](docs/doc-agent-architecture.md) ·
[`doc-storage-model`](docs/doc-storage-model.md) · [`doc-governance-model`](docs/doc-governance-model.md) ·
[`context-engine-guide`](_meta/context-engine-guide.md).

---

## 🌱 Get started (use this template)

Synapse is a GitHub **Template repo** — you don't fork it, you *instantiate* it as your own private vault.

1. **Use this template / clone.** Click **"Use this template"** on GitHub (or `git clone` it), then open
   the new repo as your private vault.
2. **Prerequisites.**
   - **Node 22+** (the engine uses Node's built-in `node:sqlite` — no native deps).
   - **OpenCode** (`opencode-ai`) on PATH — the agent runtime.
   - **Ollama** reachable (local or over Tailscale) — the model + embedding server.
   - `ollama pull mxbai-embed-large` — the default embedding model for semantic recall.
3. **Wire the CLI.** `node _meta/tools/install.mjs` (dry-run), then `--write` (idempotent). Open a new terminal (or `exec $SHELL`) to pick up the new PATH.
4. **Create the records DB.** `node _meta/tools/apply-migrations.mjs` applies `0001-init-schema.sql` →
   a fresh `db/synapse.db` (gitignored, replayable from migrations).
5. **Make it yours.** Set your name for the nightly canary (`export VAULT_USER="Your Name"`), and record
   ownership in the DB: copy `migrations/0002-owner.sql.example` → `migrations/0002-owner.sql`, fill it in,
   then `apply-migrations.mjs` again.
6. **Start capturing.** Append freeform thoughts to `inbox/`, then let `ingester` atomize them — see
   **A day in the life** above.

---

## 📚 More

- **Full command reference** (every command, env var, flag, runtime sink) → [`doc-cli-reference`](docs/doc-cli-reference.md)
- **Browse the graph in Obsidian** (color-coded by type) → [`doc-repo-layout`](docs/doc-repo-layout.md)
- **The privacy gate** (framework readable, vault sealed; `vault-gate on|off`) → [`doc-deployment-gate`](docs/doc-deployment-gate.md)
- **Staying healthy** (lint, pre-commit hook, the nightly curator loop) → [`doc-maintainer-loop`](docs/doc-maintainer-loop.md) · [`loop-maintain-synapse`](loops/loop-maintain-synapse.md)
- **Two-repo model** (framework vs. your private vault, pulling upstream updates) → [`doc-fork-and-extend`](docs/doc-fork-and-extend.md)
- **Extending** (new note / rule / agent / domain / migration) → [`_meta/conventions.md`](_meta/conventions.md) · [`CONTRIBUTING.md`](CONTRIBUTING.md)
- **The vision & full architecture** → [`doc-vision`](docs/doc-vision.md) · [`moc-synapse`](moc-synapse.md)

---

## 🙏 Acknowledgments

Special thanks to **[@JavierCorado](https://github.com/JavierCorado)** — for teaching me and inspiring me
to develop this. Synapse builds on Andrej Karpathy's
["LLM Wiki" gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) (the seed idea),
[OpenCode](https://opencode.ai), [Ollama](https://ollama.com), [Obsidian](https://obsidian.md), Node's
built-in SQLite, Reciprocal Rank Fusion ([`sqlite-vec`](https://github.com/asg017/sqlite-vec) as the
scale-up path), and [MemPalace](https://github.com/MemPalace/mempalace). Full credits → [`CREDITS.md`](CREDITS.md).

## License

[MIT](LICENSE) © 2026 Emmanuel Borja. Use the pattern with any model and any data.
