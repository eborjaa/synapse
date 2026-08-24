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

Keep the vault **private**. It is your knowledge, and the records DB is real data.

---

## 2. Wire your editors (MCP)

Two commands overlap here; pick by how much you want.

```bash
npx synapse mcp-config --write   # the minimum — just the MCP client configs
```

That is what `synapse init` recommends when it finishes, and it is enough for the vault to appear as tools
in your editors. The fuller option also installs the shell CLI (the `curator` / `oracle` / `vault-*`
launchers and `--cli` sinks):

```bash
npx synapse install --write      # MCP configs + agents.sh shell CLI + editor dirs
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

> Two surfaces exist. `full` is everything; **`orchestrator`** adds the delegation tools
> (`synapse_claim_and_brief`, `synapse_spawn_release`, `synapse_history`, `synapse_recall`). Pick with
> `SYNAPSE_MCP_SURFACE`, or regenerate one client with
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
[synapse-mcp] ready · v1.0.0 · surface=orchestrator · vault=/path/to/my-vault
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
