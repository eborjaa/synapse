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
[npm package](#-npm-package--tooling-only) · [More](#-more)

---

## 🚀 Quick start

```bash
cd /path/to/your-vault
npm install @eborja/synapse@^0.10.0   # or: npm install ../path/to/synapse-framework
npx synapse install                        # dry-run
npx synapse install --write                # wire agents.sh + editor dirs
exec $SHELL
synapse agents                             # ← list agents (or: vault-agents)
synapse hubs                               # ← list hub targets (or: vault-hubs)
```

> The engine is the **`@eborja/synapse` npm package** (`bin/synapse`, `lib/*`, `agents.sh`). Your vault
> keeps only content + `_meta/tools/context.manifest.json`. After install, `synapse <sub>` is the unified
> front door (engine + shell).

## ⚡ Your first commands

Type an agent's name, point it at a target, optionally describe a task. The agent launches **with the full
briefing** (mission + rules + skills + the target's neighborhood) compiled deterministically — no copy-paste:

```bash
curator                                          # run the steward — detect drift across the vault
curator hub-finances                             # scope it to one domain hub
oracle hub-finances "did I note anything about budgeting?"   # ask the vault — read-only, cited
reconciler hub-contacts                          # fix one drifted domain's notes/views
ingester inbox/2026-06-15.md                     # atomize a freeform capture into typed notes + rows
```

**Syntax:** `<agent> [<target>] [--profile lean|standard|fat] ["task"]`. A `hub-*` target auto-upgrades a
`lean` agent to `standard`. → **Full command reference, env vars & flags:** [`doc-cli-reference`](docs/doc-cli-reference.md).

---

## 🔮 Ask the vault + semantic recall

The **oracle** answers questions grounded in your vault — read-only, every claim cited back to the note
that owns it, never a fabrication:

```bash
oracle hub-finances "what did I decide about the emergency fund?"
```

What makes the answer *good* is **semantic recall** — an opt-in second retrieval phase. The render engine
is deterministic: it follows *typed links*, so it only reaches what you explicitly connected. Semantic
recall adds the missing half — **embedding-based search** that finds conceptually-related notes across the
whole vault, regardless of links or wording, and appends them under a clearly-labeled
`## Semantically related (not yet linked)` section. This is classic **hybrid retrieval** (graph + vector).

**Turn it on (all local, no new deps):**

```bash
ollama pull mxbai-embed-large   # one-time, on the Ollama host that serves your model
synapse setup --write           # provisions the runtime AND builds the index
```

**Staying fresh is not your job.** The index is derived from the markdown, so it goes out of date every
time you edit a note — and a stale index does not error, it just quietly ranks against the vault as it
was. So `synapse augment` checks before it reads, re-embeds incrementally when it is behind, and when it
cannot (offline, or a rebuild is already running) says so **in the briefing itself**:

```
> ⚠ semantic index is 42 note(s) behind the vault — run `synapse embeddings` (…).
```

Ask any time with `synapse embeddings-status` (or the `synapse_embeddings_status` MCP tool, which reports
`staleCount`). A fleet of agents sharing one vault is safe: a lock collapses simultaneous rebuilds into
one. Disable the self-heal with `SYNAPSE_NO_REFRESH=1` — the warning still prints.

Embeddings come from the **same local Ollama** that runs the agents — no API key, no cloud. Results are
**additive, labeled, and non-authoritative**: a similarity hit never silently drives a change, and when a
hit is genuinely relevant the agent **promotes it to a typed `related:` link** — so semantic discovery
*feeds the deterministic graph*, and the vault grows more precise the more you use it.

→ Full detail: [`doc-semantic-recall`](docs/doc-semantic-recall.md) ·
[`rule-semantic-suggests-links-decide`](rules/rule-semantic-suggests-links-decide.md) ·
[`tool-ollama-embeddings`](tools/tool-ollama-embeddings.md).

## 🧠 Three kinds of memory

| Memory | What it holds | Where it lives |
|---|---|---|
| **Procedural** | how to act — agents, rules, skills | typed notes, walked by `render` |
| **Semantic** | what is true — your notes | typed notes + `augment`'s embedding recall |
| **Episodic** | what already happened | `synapse_history` / `synapse_log` (v0.12) |

Episodic memory is the one most agent stacks skip, and its absence is why every session starts
amnesiac — a lead re-plans work a doer finished yesterday. Delegated work records itself: an episode
opens inside `synapse_claim_and_brief` and closes inside `synapse_spawn_release`, the two calls a
delegation cannot skip. Re-claiming a job that already ran returns what came of it (`priorRun`) instead
of silently repeating it.

```
synapse_history({ query: "REL-38837" })
→ agent-debug-triager · done · "root cause = stale anchor in the grid POM; parked 2 specs" · [PR#41]
```

**Keeping context live as the task moves.** A briefing is rendered once, at dispatch — ten turns later
the agent has moved to a new subtask with its context frozen at turn 1, which is how agents drift. Two
tools close that gap:

- **`synapse_recall({task})`** (v0.14) — the top-up. Given what the agent is doing *now*, it returns only
  the delta: notes relevant to the subtask, any rule that now applies, and whether it was already done —
  never the whole briefing. When a task names a suite it routes toward it (v0.15), and if nothing is
  relevant it says so rather than inventing filler.
- **On-demand notes** (v0.13) — a note marked `on_demand: true` with a `trigger:` renders as a ~35-token
  line under a **"Fetch before you act"** checklist instead of its body. A 6,000-token comment template
  becomes one trigger the agent can't miss, and the body is fetched only at the moment it applies.

The common thread: **push what an agent cannot know to ask for; let it pull the rest.** The deterministic
keyword match behind suite routing, on-demand triggers, and hub inference is one small function doing
triple duty.

## 🔌 Pluggable runtime (`--cli`)

OpenCode is the **default** runtime, not the only one. The *same* rendered briefing can be handed to a
swappable sink with `--cli` — so you can drive Synapse with whatever tool you like:

```bash
curator hub-finances "rebuild summaries"                  # → OpenCode (default, local Ollama)
curator hub-finances "rebuild summaries" --cli claude     # → Claude Code, scoped to the repo dir
oracle hub-health "trend since April?"   --cli clip       # → copy the briefing to the clipboard
reconciler hub-contacts                  --cli print      # → write the briefing to stdout, pipe anywhere
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
oracle hub-finances "how much have I spent on home repairs?"

# 4. MAINTAIN — the steward keeps the graph schema-clean and the views current.
curator hub-finances "summaries look stale"     # detect → heal the unambiguous → escalate the rest → PR
synapse lint --strict              # confirm the vault is schema-clean
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
| **② a Target** | the **what** (which *domain/unit*) | the knowledge to act on | `hub-finances` · a note `id` |
| **③ a Profile** | the **dial** (how *much* context) | `lean` (~4K) · `standard` (~15K) · `fat` (~30K) | which relationship roles to pull |

**The four agents** — three writers + one reader. *Maker ≠ checker:* the agent that writes an edit never
approves it. Click a name to open and tune its file.

| Agent | Job |
|---|---|
| 🧹 [`agent-curator`](agents/agent-curator.md) | **steward** — detect drift, heal the unambiguous, dispatch + verify, open one human-gated PR |
| 🔧 [`agent-reconciler`](agents/agent-reconciler.md) | **scoped doer** — reconcile ONE drifted unit against its source (no PR, no DB write) |
| 📥 [`agent-ingester`](agents/agent-ingester.md) | **capture** — atomize one `inbox/` dump into typed notes + proposed migration rows |
| 🔮 [`agent-oracle`](agents/agent-oracle.md) | **reader** — grounded, cited Q&A over a domain's closure + semantic recall (never writes) |

**Run agents as chat-able standing bots.** The same four agents can run as always-on bots you
@mention in chat (an `oracle` that answers, a `curator` that maintains), briefing from this vault over
MCP. That operator layer is its own package — **[Cortex](https://github.com/eborjaa/cortex)**
(`@eborja/cortex`): `init` an instance, `provision` the agents, `start` them, `doctor` the stack.
Cortex renders each bot's prompt from `synapse render` and gives each its own MCP surface (so a
read-only `oracle` literally can't see the write tools). Synapse is the brain; Cortex is the operator.
Cortex derives its roster from the vault: any agent note with `addressable: true` is a standing bot.
Scaffold one ready to run with **`synapse new agent <id> --addressable`** (0.8+), or add the flag to
an existing note.

**The graph is hub-and-spoke.** One master hub links out to seven domain hubs; members roll up
automatically (a note's `related: ["[[hub-x]]"]` *makes* it a member of `hub-x` — the hub is never edited
by hand).

```
                          [[hub-synapse]]   ← master hub: architecture · domains · method
                               │
   ┌──────────┬───────────┬────┼────┬───────────┬────────────┬──────────────┐
hub-finances hub-contacts hub-health hub-places hub-journal hub-projects hub-social-media
```

**Two substrates, one gate.** Markdown is canonical for knowledge, SQLite for records; where they meet,
one side is canonical and the other is a *generated, never-hand-edited* projection. **Records never mutate
unattended** — every DB change rides a migration file through a human gate. Governance is per-repo: the
framework is fully PR-gated, vault Markdown self-heals, and the records DB is gated everywhere.

→ Deeper: the in-vault map [`hub-synapse`](hub-synapse.md) · [`doc-agent-architecture`](docs/doc-agent-architecture.md) ·
[`doc-storage-model`](docs/doc-storage-model.md) · [`doc-governance-model`](docs/doc-governance-model.md) ·
[`context-engine-guide`](_meta/context-engine-guide.md).

---

## 🌱 Get started

Synapse ships **two layers**:

1. **`@eborja/synapse`** — the publishable tooling package (`bin/`, `lib/`, `agents.sh`, `schema/`).
2. **Reference vault content** in this repo — agents, rules, docs, starter hubs, `migrations/0001-*.sql`
   (not in the npm tarball; kept so you can copy a private vault).

### Option A — new private vault (recommended)

```bash
mkdir my-vault && cd my-vault
npm init -y
npm install @eborja/synapse@^0.10.0
# copy schema example → your ontology dial
mkdir -p _meta/tools
cp node_modules/@eborja/synapse/schema/context.manifest.example.json \
   _meta/tools/context.manifest.json
# copy starter agents/rules/hubs from the template repo if you want them, or author your own
npx synapse setup --write      # Ollama + embed model (optional)
npx synapse install --write    # shell CLI + editor wiring
npx synapse migrate            # create db/synapse.db from migrations/
exec $SHELL
synapse agents && synapse hubs
```

### Option B — use this repo as a template

1. Click **"Use this template"** (or clone), keep it **private**, and treat it as your vault.
2. **Prerequisites:** Node 22+ (`.nvmrc` pins `22`), OpenCode (or Claude/Cursor via `--cli`), Ollama.
3. From the vault root: `npm install` (links `@eborja/synapse` if present) → `npx synapse install --write`
   → `npx synapse migrate` → `exec $SHELL`.
4. Set `export VAULT_USER="Your Name"`, fill `migrations/0002-owner.sql` from the example, migrate again.
5. Capture into `inbox/`, then `ingester …`.

Updating the engine later is an **npm bump**, not a git merge of tooling files. See
[`doc-fork-and-extend`](docs/doc-fork-and-extend.md).

---

## 📦 npm package — tooling only

Distribute and update the **engine** without forking vault content:

```jsonc
{
  "dependencies": {
    "@eborja/synapse": "^0.10.0"
  },
  "scripts": {
    "vault:render": "synapse render",
    "vault:lint": "synapse lint",
    "vault:migrate": "synapse migrate",
    "vault:install": "synapse install"
  }
}
```

```bash
npm install
npx synapse setup --write     # Ollama + embed model (optional; deterministic tools work without it)
npx synapse install --write   # shell + editor wiring
```

Alternate installs (dev / pin a git SHA): `npm install github:eborjaa/synapse#v0.12.0` or
`file:../synapse-framework`.

The consumer keeps `context.manifest.json` under `_meta/tools/` (flat) or `context-vault/_meta/tools/`
(nested). Copy [`schema/context.manifest.example.json`](schema/context.manifest.example.json). Vault
resolution: `$SYNAPSE_VAULT` → ancestor walk from `$PWD`. See [`CHANGELOG.md`](CHANGELOG.md) and
[`doc-fork-and-extend`](docs/doc-fork-and-extend.md).

| Command | Does |
|---|---|
| `synapse render <id> …` | Typed-ontology briefing |
| `synapse augment … --task` | render + semantic recall |
| `synapse new agent <id> --addressable` | Scaffold an agent note runnable as a Cortex standing bot |
| `synapse lint [--strict]` | Vault health-check |
| `synapse embeddings` | Rebuild `note_vectors` |
| `synapse embeddings-status` | Is that index current? (`--json` / `--refresh`) |
| `synapse index` / `views` / `migrate` | SQL projections + migrations |
| `synapse setup` / `install` | Runtime + shell wiring |
| `synapse agents` / `hubs` / `help` | Shell discovery (after `install --write`; `vault-*` equals) |

---

## 📚 More

- **What's shipped and what's next** → [ROADMAP.md](ROADMAP.md)

- **Full command reference** (every command, env var, flag, runtime sink) → [`doc-cli-reference`](docs/doc-cli-reference.md)
- **Browse the graph in Obsidian** (color-coded by type) → [`doc-repo-layout`](docs/doc-repo-layout.md)
- **The privacy gate** (framework readable, vault sealed; `vault-gate on|off`) → [`doc-deployment-gate`](docs/doc-deployment-gate.md)
- **Staying healthy** (lint, pre-commit hook, the nightly curator loop) → [`doc-maintainer-loop`](docs/doc-maintainer-loop.md) · [`loop-maintain-synapse`](loops/loop-maintain-synapse.md)
- **Engine package** (`@eborja/synapse` vs your private vault; npm bump to update tooling) → [`doc-fork-and-extend`](docs/doc-fork-and-extend.md)
- **Extending** (new note / rule / agent / domain / migration) → [`_meta/conventions.md`](_meta/conventions.md) · [`CONTRIBUTING.md`](CONTRIBUTING.md)
- **The vision & full architecture** → [`doc-vision`](docs/doc-vision.md) · [`hub-synapse`](hub-synapse.md)
- **Run standing agents on your vault** (chat-able `oracle`/`curator` over Buzz) → **[Cortex](https://github.com/eborjaa/cortex)** (`@eborja/cortex`)
- **Delegate with enforced dedup, keeping your CLI's features** — the MCP `orchestrator` surface adds
  **`synapse_claim_and_brief`**: it claims the job (SQLite lease on a canonical `job` id + a semantic
  same-task pre-check) and hands back the doer's briefing; **you** launch with your own harness (Task
  tool, `@mention`, terminal), so the task panel, streaming and completion notification all still work.
  Dedup is unskippable because the briefing only comes *through* the claim. `synapse_spawn` is the
  specialist alternative — synapse launches a **detached** doer that outlives your session (CLI-agnostic
  across cursor/claude/opencode) at the cost of harness visibility. See [`CHANGELOG.md`](CHANGELOG.md)
  (0.10.0) and `mcp/tools/spawn.mjs`.

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
