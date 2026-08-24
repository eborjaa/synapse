---
id: doc-install-end-to-end
type: doc
title: "Install end to end — a new machine to a working vault with agents in DSH"
tags:
  - type/doc
  - area/runtime
  - status/active
references_docs: ["[[doc-runtime-wiring]]", "[[doc-mcp-tools]]", "[[doc-cli-reference]]"]
related: ["[[hub-synapse]]"]
---

# Install end to end — a new machine to a working vault with agents in DSH

The README's Quick start gets you a **vault**. This guide goes further: a machine with nothing on it to a
vault whose agents you can delegate to from the **DeepSeek Harness**, with the lease governance enforced.

Six steps, ~15 minutes, most of it downloads. Every command here was run on a real machine — where a step
can fail quietly, the check that catches it is included.

> **Which parts do you actually need?**
> Steps 1–3 give you a working vault usable from Claude Code, Cursor and opencode — that is the whole
> product for most people. Steps 4–6 add DSH and the delegation governance. Stop after 3 if you do not
> use DSH.
>
> **Already have a vault?** Skip to [Upgrading a vault you already
> have](#upgrading-a-vault-you-already-have) — you do not need steps 1–3.

---

## 0. Prerequisites

| | |
|---|---|
| **Node** | 22 or newer (`node -v`). The engine declares `>=22`. |
| **git** | for the vault itself |
| **A model** | either a local [Ollama](https://ollama.com) host, or a hosted provider key. Steps 1–3 work with **no model at all** — the deterministic tools (render, lint, migrate) never call one. |

---

## 1. Create the vault

```bash
mkdir my-vault && cd my-vault
npm init -y
npm install @eborja/synapse

npx synapse init            # dry-run — lists the 37 notes it would copy in
npx synapse init --write    # manifest + the four agents + rules + starter hubs
```

`init` only fills in what is missing, so it is safe to re-run after an engine bump to pick up notes a new
version ships. It prints its own next steps when it finishes — follow those if they ever disagree with
this guide.

**Check it:**

```bash
npx synapse lint            # should end: clean (errors=0)
git init && git add -A && git commit -m "vault: initial scaffold"
```

> **About the database.** `init` scaffolds *notes* and ships **zero migrations** — Markdown is canonical
> for knowledge. `db/synapse.db` holds **records** (contacts, accounts, finances, health), and a fresh
> vault has none yet.
>
> ```bash
> npx synapse migrate     # prints "up to date — nothing to apply", and creates an empty db/synapse.db
> ```
>
> Run it if you want the file to exist now; skip it and nothing breaks. The vault lints clean and every
> read tool works with no database at all. The DB starts mattering when you author your first migration
> under `migrations/` — that is the only path that writes records, and it is human-gated by design.

Keep the vault **private**. It is your knowledge, and once records land the DB is real data.

---

## 2. Wire your editors (MCP)

Three commands get confused with each other. Only the first two belong to this step:

| Command | What it does | Needed? |
|---|---|---|
| **`mcp-config --write`** | writes **only** the MCP client configs (`.mcp.json`, `.cursor/mcp.json`, `opencode.json`) | **yes** — this step's minimum |
| **`install --write`** | a **superset**: the same configs **plus** the `agents.sh` shell CLI (one verb per agent, the `vault-*` helpers, the `--cli` sinks), editor dirs, and one `/synapse-<agent>` harness skill per agent your vault defines | either this or the above |
| **`setup --write`** | **unrelated to both.** Provisions the *semantic* runtime — Ollama plus the embedding model — and builds the recall index. That is [step 3](#3-semantic-recall-optional). | no, optional |

`setup` is the one people reach for by name, and it is the one with nothing to do with wiring — it never
touches an MCP config.

```bash
npx synapse mcp-config --write   # the minimum — just the MCP client configs
```

That is what `synapse init` recommends when it finishes, and it is enough for the vault to appear as tools
in your editors. Or take the superset, which also installs the shell CLI:

```bash
npx synapse install --write      # MCP configs + agents.sh shell CLI + editor dirs + harness skills
exec $SHELL                      # picks up the shell CLI
```

Either way you get the MCP client configs, so the vault appears as tools inside the editors you already
use:

| Client | File written |
|---|---|
| Claude Code | `.mcp.json` |
| Cursor | `.cursor/mcp.json` |
| opencode | `opencode.json` |

**Check it** — from inside the vault:

```bash
claude mcp list                     # or: cursor-agent mcp list · opencode mcp list
synapse agents && synapse hubs      # only if you ran `install --write`
```

Each should report a `synapse` server that connects. In Claude Code a project-scoped server needs
**approval on first use** — if it shows `⏸ Pending approval`, approve it and re-check.

> **Four surfaces**, each a superset of the last: `skeleton` (3 tools) · `standard` (11, read-only) ·
> `full` (20, adds authoring — the default) · **`orchestrator`** (26, adds `synapse_claim_and_brief`,
> `synapse_spawn_*`, `synapse_spawn_release`). It is a permission dial: a tool off the surface is never
> registered, so it cannot be called. Pick with `SYNAPSE_MCP_SURFACE`, or regenerate one client with
> `synapse mcp-config --write --client claude --surface orchestrator`.

---

## 3. Semantic recall (optional)

Deterministic rendering follows *typed links only*. Semantic recall adds embedding search across the whole
vault, labelled as suggestions rather than facts.

```bash
ollama pull mxbai-embed-large   # on the host that serves your model
npx synapse setup --write       # provisions the runtime AND builds the index
npx synapse embeddings-status   # should report the index current
```

Skip this and everything else still works — briefings simply carry no
`## Semantically related` section.

---

## 4. Install the DeepSeek Harness

```bash
npm install -g @deepseek-ai/dsh
dsh --version                    # 0.1.1-rc.2 at time of writing
```

DSH is pre-release and moves fast. Prefer the npm install over a source checkout unless you intend to
develop against it — building from source needs `pnpm install` plus a full `npm run build`.

---

## 5. Wire the vault into DSH

DSH is the one client `synapse install` does **not** generate a config for: its wiring is a
`cordis.patch.yml` patch layer under `~/.dsh`, not a JSON file in the repo. That is what
[`@eborja/dsh-synapse`](https://github.com/eborjaa/dsh-synapse) installs.

```bash
cd /path/to/my-vault
npx @eborja/dsh-synapse install            # dry-run — shows every file it would write
npx @eborja/dsh-synapse install --write
```

It writes three things into `~/.dsh`, resolving your vault path and an **absolute** node path (dsh scrubs a
spawned child's env, so a bare `node` may not resolve):

- **the MCP client row** — `@deepseek-ai/dsh-mcp-client` pointing at your vault's `synapse-mcp` over stdio
- **the lease hooks** — `claim-guard` refuses to delegate vault work without a claim; `lease-guard` catches
  a claim that was never released
- **the agent skills** — symlinks so `/synapse-oracle` and friends work

> **Your own agents get slash commands too.** The four above are what `@eborja/synapse` ships. Run
> `synapse skills --write` (or `synapse install --write`, which includes it) to put one
> `/synapse-<agent>` in your vault repo's `.dsh/skills` per `agents/agent-*.md` — DSH's highest-ranked
> root, so no symlink is required. The four shipped skills are copied there **verbatim** (that root
> outranks the symlinks above, so a generated copy would shadow the tuned one); every other agent gets
> one built from its frontmatter.


It never touches `~/.dsh/settings.yaml` (your providers) or `~/.dsh/.credentials.yaml` (your keys).

**Point DSH at a model.** Edit `~/.dsh/settings.yaml` — this part is yours, and the package deliberately
leaves it alone. A local Ollama host over its OpenAI-compatible endpoint:

```yaml
llm-pi-ai:
  providers:
    ollama-local:
      displayName: "Ollama (local)"
      api: openai-completions
      baseURL: "http://<host>:11434/v1"
      headers:
        Authorization: "Bearer unused"   # pi-ai refuses a request with neither key nor header
      streamIdleTimeoutMs: 1800000       # a big briefing can sit a while before the first token
      compat:
        supportsStore: false
        supportsDeveloperRole: false
        supportsReasoningEffort: false
        maxTokensField: max_tokens
      models:
        - id: "<your-model>:latest"
          contextWindow: 262144
agent-default-model:
  provider: ollama-local
  model: "<your-model>:latest"
```

**Check it:**

```bash
dsh --profile web --dump-config | grep -E "^- id: (mcp-synapse|hooks-synapse|spill-policy)"
```

All three rows must appear. Re-run this after every DSH upgrade — an upstream schema change can invalidate
the patch, and the dump is how you find out.

---

## 6. Verify the whole loop

Start DSH from **inside the vault**, so it picks the vault up as the workspace:

```bash
cd /path/to/my-vault
dsh web --no-open        # then open http://127.0.0.1:3080
```

The MCP child announces itself on stderr — this proves the server started:

```
[synapse-mcp] ready · v1.1.0 · surface=orchestrator · vault=/path/to/my-vault
```

**A tool call**, scriptable:

```bash
dsh --profile headless "Call the mcp__synapse__synapse_list_agents tool and reply with just the agent ids."
```

**The delegation loop** — the part the hooks govern:

```bash
dsh --profile headless "Claim a job with mcp__synapse__synapse_claim_and_brief (agent 'oracle', \
job 'smoketest:install:verify'), then immediately release it with mcp__synapse__synapse_spawn_release \
carrying a summary. Reply DONE."
```

Then confirm from the databases, not from the chat — prose can claim a success the loop never achieved:

```bash
sqlite3 db/durable-spawn.db 'SELECT COUNT(*) FROM lease;'                 # back to its baseline
sqlite3 db/episodes.db "SELECT job,outcome FROM episode ORDER BY started_at DESC LIMIT 2;"
```

A healthy run leaves the lease count where it started and an episode marked `done`.

These two databases are **not** `db/synapse.db` and do not need migrations — the orchestrator surface
creates `durable-spawn.db` and `episodes.db` itself on first use.

---

## Upgrading a vault you already have

You already have a vault on an older engine and want the current one, DSH included. Nothing here
scaffolds — it bumps the engine and re-runs the generators.

```bash
cd /path/to/your-vault
npm install @eborja/synapse@^1.1.1     # bump the engine
npx synapse install --write            # re-wire: MCP configs + shell CLI + harness skills
                                       # (keeps your MCP surface; --surface orchestrator to change it)
exec $SHELL                            # only if the shell CLI moved
npx synapse lint                       # should end: clean (errors=0)
```

**Do NOT re-run `synapse init` to upgrade.** It scaffolds; it does not migrate. It fills gaps only, which
also means it re-adds a shipped note you deleted on purpose. Run it only on a vault you have not pruned,
and only to pick up notes a new version ships.

**What each version needs after the bump:**

| Coming from | Also run |
|---|---|
| any version | `synapse install --write` — it is idempotent and covers everything below |
| **< 1.1.0** | `synapse skills --write` — the `/synapse-<agent>` harness skills are new; nothing generates them automatically on `npm install`, so without this they simply will not exist |
| **< 1.0.0** | nothing extra — 1.x speaks both MCP protocol eras, and every client still negotiates the legacy one |

Then, if you use DSH, re-run the harness wiring — the patch layer records absolute paths, so it must be
refreshed when the engine moves:

```bash
cd /path/to/your-vault
npx @eborja/dsh-synapse install          # dry-run — read the plan
npx @eborja/dsh-synapse install --write
```

> **Check the vault it names.** The banner prints which vault it resolved and where that came from:
> `vault : /path/to/your-vault (from the directory you are in)`. It prefers the directory you are
> standing in over `$SYNAPSE_VAULT`, and warns when they disagree — worth reading on a machine with more
> than one vault, because this writes into `~/.dsh` globally. Requires `@eborja/dsh-synapse` **0.1.1 or
> newer**; 0.1.0 let `$SYNAPSE_VAULT` win and could wire the wrong vault silently.

**Verify the upgrade landed:**

```bash
npx synapse --version     # the engine actually resolving here — expect the version you installed
ls .dsh/skills            # one directory per agent → /synapse-<agent> in DSH
npx synapse mcp-config    # dry-run; expect "All current — nothing to do."
npx synapse lint          # expect "clean (errors=0…)"
dsh --profile web --dump-config | grep -E "^- id: (mcp-synapse|hooks-synapse|spill-policy)"
```

`npx synapse --version` is the one that matters: it reports the engine resolving *in this vault*, which
is what you just bumped — not a globally installed copy.

---

## Running this on a vault that already has agents

Every command here is **additive or merging** — none replaces content you wrote. Precisely:

| Command | Your agents | Your other files |
|---|---|---|
| `synapse init --write` | **never edited.** Fills gaps only — it writes a shipped note only when that path is *missing*. A customised `agent-oracle.md` is left byte-identical. | same rule for rules/, tools/, hubs |
| `synapse mcp-config --write` | n/a | **merges.** Other MCP servers in `.mcp.json` / `.cursor/mcp.json` / `opencode.json` (github, postgres, figma, a vault plugin…) are kept; only the `synapse` entry is rewritten. opencode's `model` / `provider` survive too. |
| `synapse skills --write` | **read, never written.** | a `SKILL.md` you hand-authored is reported `kept` and left alone |
| `synapse install --write` | as above — it runs the two above | appends to `~/.zshrc` / `~/.claude/CLAUDE.md` behind its own marker, replacing only its own previous line |

**Two behaviours worth knowing before you run them:**

- **`init` re-adds a shipped note you deleted.** "Fills gaps" cannot tell *deleted on purpose* from
  *not yet installed*. If you removed `agent-ingester.md` deliberately, `init --write` brings it back —
  so simply don't re-run `init` on a vault you have pruned. It is only needed to scaffold, or to pick up
  notes a new engine version ships.
- **`skills` respects an agent you customised.** The four skills this package hand-authored are installed
  verbatim *only while your agent still matches the shipped one*. Edit `agent-oracle.md`'s purpose,
  profile, `delegates_to`, `uses_tools`, `addressable` or `outputs` and the command notices, warns, and
  generates `/synapse-oracle` from **your** definition instead — a tuned skill describing a role you no
  longer have would be worse than a generic one that is accurate. Editing only an agent's prose body
  changes nothing, because the skill is built from frontmatter and the body reaches the model through
  `synapse_brief`.

Nothing here writes `db/synapse.db`; records change only through a migration you author and apply.

---

## Troubleshooting

**`dsh --dump-config` is missing the synapse rows.** The install did not apply, or a DSH upgrade changed
the patch schema. Re-run `npx @eborja/dsh-synapse install` (dry-run) and read what it plans to write.

**Delegation "runs" but produces nothing.** Check the child session for `NO_ADAPTER` under
`~/.dsh/sessions/`. It means the subagent resolved a provider name that no longer exists — usually after
renaming a provider in `settings.yaml`. The parent uses the new name, the child still resolves the old one.
This is the single highest-value thing to check here, and it looks exactly like the model misbehaving.

**The model claims a job then waits forever.** `synapse_claim_and_brief` takes the lease and returns a
briefing — it launches **nothing**. The harness's own `subagent` tool is what starts the doer, and it needs
`run_in_background: false` to wait for the answer. Polling `synapse_spawn_status` for a worker nobody
launched just burns the lease's TTL.

**A briefing arrives truncated** ("Omitted N bytes"). Raise `spill-policy.maxInlineBytes`; a standard
briefing is ~60 KB and the 50000 default cuts it.

**A lease is stuck open after an interrupted run.** The Stop-hook guard fires on a clean turn-end but
**not on an interrupt**, so an interrupted run leaks its lease until the TTL expires. Release it manually
with `synapse_spawn_release` using the owner and token from the `lease` table.

---

## Related
[[doc-runtime-wiring]] · [[doc-mcp-tools]] · [[doc-cli-reference]] · [[doc-fork-and-extend]] · [[hub-synapse]]
