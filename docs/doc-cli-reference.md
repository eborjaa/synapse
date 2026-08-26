---
id: doc-cli-reference
type: doc
title: CLI & command reference — every runnable command, env var, and runtime sink
tags:
  - type/doc
  - area/runtime
  - status/active
references_docs: ["[[conventions]]"]
related: ["[[hub-synapse]]", "[[decision-0011-generated-harness-skills]]"]
---

# CLI & command reference

Everything runnable, in one place — the canonical cheat-sheet the [README](../README.md) links to.
There are **two front-ends over the same engine** (`@eborja/synapse`): the **`synapse` CLI** /
shell agent commands (after `synapse install`), and direct `node lib/<tool>.mjs` during package
development. Vault resolves from `$SYNAPSE_VAULT` or `$PWD` (flat or nested layout — see
[[doc-fork-and-extend]]).

## A. Shell CLI

Source once (`synapse install --write` → `agents.sh`). Everything is reachable as `synapse <sub>`;
the `vault-*` names are maintained equals. Agent launchers stay top-level. Engine calls (`render` /
`augment` / …) use a `synapse` binary on `PATH` when present; otherwise they run the package
`lib/*.mjs` via `node` — you do **not** need a global `npm i -g` for agents to work.

| Command | Does |
|---|---|
| `<agent> [<target>] [--profile lean\|standard\|fat] [--cli opencode\|claude\|cursor\|clip\|print] [--model <id>] [--auto\|bypass\|manual] ["task"]` | render briefing → hand to chosen runtime as **system context**; task is separate user prompt. e.g. `curator hub-finances --cli cursor --model claude-opus-4-8-thinking-high "rebuild summaries"` |
| `synapse agents` / `vault-agents` | list all agents + purpose + default profile |
| `synapse hubs` / `vault-hubs` | list all hub targets (the master + domain hubs) |
| `synapse profiles` / `vault-profiles` | explain `lean` / `standard` / `fat` (the context dial) |
| `synapse models` / `vault-models [--cli …] [--refresh]` | list models for a CLI (`--model` TAB-completes per `--cli`) |
| `synapse reload` / `vault-reload` | force re-source `agents.sh` (also auto-reloads when the file is edited) |
| `synapse bedrock` / `vault-bedrock on\|off\|status` | enable/disable AWS Bedrock via Cursor team-role |
| `synapse gate` / `vault-gate on\|off\|status` | host privacy gate (seal / unseal the vault) |
| `synapse help` | combined engine + shell cheat-sheet |

**Tab completion (zsh + bash):** after `synapse install --write`, Tab fills:

- **agent names** — top-level (`cura<Tab>`) and under `synapse` (`synapse ora<Tab>`)
- **hub targets** — after any agent (`curator hub-<Tab>` → `hub-finances`, …)
- **profiles / flags / --model** — as before (`--profile`, `--cli`, `--model` per runtime)

Completion re-resolves the vault on every Tab via the `$PWD` walk, falling back to `$SYNAPSE_VAULT`
and then to the non-exported `$SYNAPSE_VAULT_FALLBACK` that `install --write` writes into your rc — so
it works from any directory, including outside every vault.

**Status banners:** agent launches print emoji-tagged stderr steps so you can see what's happening at a
glance — e.g. `⏳ building briefing…` then `🚀 🧭 curator + hub-finances (📦 standard, ~12k tok 🔍 +semantic, auto) → 🖥️ cursor`.
Agent icons: 🧭 curator · 🔮 oracle · 🔧 reconciler · 📥 ingester. Discovery commands (`synapse agents` /
`hubs` / `profiles` / `models`) use the same vocabulary.

### Launcher grammar (full)

```
<agent> [<target>] ["task text"] [--handover <ref>] [--prompt-file <path>] \
        [--profile lean|standard|fat] [--cli opencode|claude|cursor|clip|print] \
        [--model <id>] [--auto|--bypass|--manual] [--no-semantic] [--clipboard]
```

- **`<target>`** (optional) — a `hub-*`/`moc-*` or any note id that RESOLVES in the vault. The first
  positional is treated as a target only if it is `hub-*`/`moc-*` (a typo still errors clearly in render)
  or resolves to a real note file; **anything else — including a one-word task like `"hi"` — is the
  task.** A `hub-*` target auto-upgrades a `lean` agent to `standard`.
- **`"task text"`** (optional) — a bare quoted string. Supplying a task auto-routes through the semantic
  `augment` when the embedding index exists. `--profile` and value-flags are consumed from ANY position,
  so they never leak into the task.
- **`--handover <ref>`** — boot the agent FROM a handover note (a path anywhere incl. `journal/`, or a
  fuzzy slug in `inbox/handovers/`): the note becomes the task, with the successor protocol prepended.
  `--prompt-file <path>` is the same without the protocol. If a bare `"task text"` is ALSO given, the two
  **compose**: the handover is the task-of-record and the inline string is appended as an
  "Additional instruction for THIS launch" — neither is dropped, and a `<target>` still fuses.
- **`--cli`** — `opencode` (default) · `claude` · `cursor` · `print` (briefing+task to stdout) ·
  `clip` (to clipboard). `--clipboard`/`-c` forces the clipboard on any runtime.
- **`--auto`/`-y` · `--bypass`/`--yolo` · `--manual`/`--safe`/`--confirm`** — the runtime's permission
  posture (default `auto`).

**Canonical shape:** `qa-lead moc-sensors "steer this run" --handover <ref> --cli cursor --profile standard`.

## B. `synapse` CLI (npm package)

```bash
synapse render agent-curator hub-finances --profile standard
synapse render --lint
synapse lint [--strict]
synapse migrate [--status]
synapse index
synapse views
synapse embeddings [--all]
synapse embeddings-status [--json] [--refresh] [--fast]   # is the embeddings cache current?
synapse augment agent-curator hub-finances --profile standard --task "…"
synapse setup [--write]
synapse install [--write]
synapse journal "slug"
synapse handover-task <ref> [--plain]        # print a note (a handover) as a task string
synapse new <kind> <name> [--write]          # hub | agent | note | handover
synapse mcp-config [--write]                 # MCP client config for this vault
synapse-mcp                                  # stdio MCP, one env-pinned vault (default)
synapse-mcp --http [--host H] [--port N] [--path /mcp] [--surface S]
                                             # one bearer-bound server, many vaults
```

### `synapse skills` — your agents as `/synapse-<agent>`

```bash
synapse skills                            # dry run
synapse skills --write                    # → <vault-repo-root>/.dsh/skills/synapse-<agent>/SKILL.md
synapse skills --write --agent oracle     # just one
synapse skills --write --out ~/.dsh/skills   # the user-scoped root instead of the vault's
synapse skills --write --force            # also overwrite hand-authored skills (destructive)
```

> **`synapse install --write` already does this** (as its 5th step) — run `skills` on its own after adding
> an agent, or to target a different root.

Generates one harness skill per `agents/agent-*.md` **in the resolved vault**, so a vault with its own
roster gets its own slash commands rather than the four the package happens to ship. The roster is read,
never hardcoded — the same contract `agents.sh` and `synapse_list_agents` already honour
([[decision-0008-addressable-vs-autonomous]], [[decision-0011-generated-harness-skills]]).

**Where it writes.** Default is the vault **repo root**'s `.dsh/skills` — DSH discovers that as
`project-dsh`, its highest-ranked root, so no symlink or YAML is involved. It is the repo root and not
`vaultDir` on purpose: DSH resolves that root by walking up from its launch directory for `.git`, which
under the nested layout lands on the repo root, not `context-vault/`. When there is no `.git` at all DSH
falls back to its launch directory, so the command warns and points you at `--out ~/.dsh/skills` — the
user-scoped root `@eborja/dsh-synapse` symlinks, which works from anywhere.

**What lands in the file.** A procedure, not a payload: step 2 is always `synapse_brief` with that agent's
own id and declared `profile`, and the briefing stays the real context. Conditional blocks key on declared
frontmatter only:

| Emitted | Condition |
|---|---|
| the package's own hand-authored skill, verbatim | `.dsh/skills/<name>/SKILL.md` ships for that agent |
| catalog `description` | `purpose` (capped) + a trigger sentence from `tags: area/*` |
| `## Delegating` — the claim → `subagent` → release spine | `delegates_to` is non-empty |
| verify + record steps, "propose, do not push" | `uses_tools` has `tool-lint` or `tool-git` |
| "Never mutate" instead of those | it has neither |
| "You are addressable" | `addressable: true` |
| `## What you produce` | `outputs` is non-empty |

An agent whose id cannot make a valid DSH skill name (`^[a-z0-9]+(?:-[a-z0-9]+)*$`), or that has no
`purpose`/`title` to route on, is **skipped with a warning** rather than silently renamed — DSH would drop
it at load anyway, and a warning here is visible.

**Hand-authored wins, twice over.** A `SKILL.md` without the generated marker (an HTML comment on the
first body line) is reported as `kept` and left alone; `--force` overwrites it and discards those edits.
And where **this package** ships a hand-authored skill for an agent — `oracle`, `curator`, `ingester`,
`reconciler` — that copy is installed **verbatim** (reported as `shipped`) rather than generated. That is
load-bearing, not cosmetic: DSH ranks the project root (100) above the user root (400) that
`@eborja/dsh-synapse` symlinks the shipped skills into, so generating over a shipped name would shadow
the tuned version with a generic one. The template is the floor for agents the package ships nothing for.

### `synapse mcp-config` — wiring a vault for MCP

```bash
npm install                    # installs the synapse-mcp bin into this vault
synapse mcp-config --write     # writes .mcp.json + .cursor/mcp.json + opencode.json
```

> **`synapse install --write` already does this** (as its 4th step) — run `mcp-config` on its own only to
> regenerate with a different `--surface`/`--client`, or after moving the vault.

Generates config pointing at **this vault's own** `node_modules/.bin/synapse-mcp`, so the identical
commands wire any vault or sub-vault on the machine — nothing is hand-edited and nothing
hardcodes another machine's layout. `--client claude|cursor|opencode` narrows the target; `--surface
skeleton|standard|full|orchestrator` picks the tool set (use `standard` for read-only agents,
`orchestrator` to add the dedup-safe delegation tools).

**opencode needs its own file.** opencode reads neither `.mcp.json` nor `.cursor/mcp.json`, so it gets an
`opencode.json` (key `mcp`, `command` as an ARRAY, env under `environment`). The file is **merged, never
overwritten** — your `model`/`small_model`/`provider` survive regeneration. Extra plugin env via
repeatable `--env KEY=VAL` (carried over between clients so one plugin's requirement isn't dropped).

**Provider policy — synapse does NOT own your model runtime (agnostic).** The ollama provider (endpoint,
models, tuning) is *your* config; `mcp-config`/`install` never clobber one you set (project or global
`~/.config/opencode/opencode.json`). A provider is seeded in **one** case only — a *total vacuum* (no
provider anywhere) — as a native `localhost`/`api` starter for the zero-config local user (`SYNAPSE_OLLAMA_URL`
overrides the host). Otherwise synapse stays hands-off and, if the effective provider is on ollama's `/v1`
path, prints an **advisory**: `/v1` *streaming* drops tool-call deltas (opencode #20995, ollama #5769) so
MCP tools silently never fire — switch that provider to `npm: "ollama-ai-provider-v2"` + a `/api` baseURL.
The fix belongs in your global opencode config so every vault benefits.

**Vault plugins** need no config entry: any `_meta/mcp-plugins/*.mjs` exporting
`register(server, ctx)` is auto-discovered and registered after the built-ins. Use it for tools
specific to one vault, so nothing consumer-specific has to enter the package.

### `synapse-mcp --http` — one local endpoint, many vaults

```bash
synapse vaults token <vault-id> --label "client name"
synapse-mcp --http --host 127.0.0.1 --port 3000 --surface standard
# endpoint http://127.0.0.1:3000/mcp · Authorization: Bearer <the minted syn_... token>
```

stdio is unchanged and remains the no-flag default. HTTP binds each request from the bearer credential
through the vault registry; no tool accepts a vault selector. The listener defaults to
`127.0.0.1:3000/mcp`. `--host` may be loopback or an explicit VPN-interface address, but never
`0.0.0.0` or `::` — both are rejected before listening. Run exactly one instance against a set of vault
databases.

The shared HTTP server has no one vault from which to auto-discover plugins. Set
`SYNAPSE_MCP_PLUGINS=/absolute/shared-plugin.mjs[, …]` for plugins intended to appear for every
credential; per-vault `_meta/mcp-plugins/` discovery remains on stdio. During package development, before
the new package version is installed, run `node bin/synapse-mcp.mjs --http …`.

### `synapse new` — scaffolding

Generates notes that satisfy the schema `synapse lint` enforces (both read `lib/schema.mjs`, so the
generator and the checker cannot drift). **Dry-run by default; `--write` creates.**

```bash
synapse new hub climbing --parent hub-synapse --write
synapse new agent scribe --purpose "Draft release notes" --rules rule-canary --tools tool-git --write
synapse new note zone2-pacing --type note --hub hub-health --write
synapse new handover continue-gate-6 --plan plan-buzz-gated-learning --write
```

Links are routed to the frontmatter field their **target type** requires — `rule → applies_rules`,
`tool → uses_tools`, `skill → invokes_skills`, `agent → delegates_to`, `doc → references_docs`,
everything else `related` — read from the manifest `roles` block, not hardcoded.

**`--used-by <agent-ids>` is what prevents orphans.** A new rule or tool is only reachable once an
agent *cites* it, and that edge lives in the agent's frontmatter. Without `--used-by` the note is
valid but invisible, and lint reports `orphan (no inbound links)`:

```bash
synapse new note my-rule --type rule --used-by curator,oracle --write
#   wired: agent-curator.applies_rules += rule-my-rule
```

(The wired value is a real wikilink; it is written unbracketed here because `synapse lint` scans
fenced code too, and a sample link would register as an unresolved one.)

Writes resolve the vault from the **current directory first**, so a stale exported `SYNAPSE_VAULT`
cannot silently create the note in another vault; the destination is echoed on every run. `install
--write` never exports `SYNAPSE_VAULT` at all — see the env table below.

Over MCP the same core is exposed as `synapse_create_{hub,agent,note,handover}` on the **full**
surface, which **propose by default** and write only when called with `write: true`.

Engine subcommands resolve via the `synapse` CLI (`bin/synapse.mjs` in this repo, or
`node_modules/@eborja/synapse` in a consumer vault). During package development you can also run
`node lib/<tool>.mjs` directly.

## Runtime environment variables

| Variable | Default | Effect |
|---|---|---|
| `SYNAPSE_CLI` | `opencode` | default runtime sink |
| `SYNAPSE_MODEL` | `ollama/qwen3.6-256k` | default for `--cli opencode` |
| `SYNAPSE_PERM_MODE` | `auto` | `manual` \| `auto` \| `bypass` |
| `SYNAPSE_CURSOR_MODEL` | `auto` | default for `--cli cursor` |
| `SYNAPSE_CURSOR_BEDROCK` | `off` | Bedrock tenant IDs opt-in |
| `SYNAPSE_EMBED_MODEL` | `mxbai-embed-large` | embedding model |
| `SYNAPSE_MIN_SIM` | `0.45` | semantic similarity floor |
| `SYNAPSE_VAULT` | _(cwd walk)_ | explicit vault root override — **you** set it; `install` never does |
| `SYNAPSE_VAULT_FALLBACK` | _(unset)_ | written to your shell rc by `install --write`, **not exported**. Last-resort vault for shells whose `$PWD` is inside none. `$PWD` and an explicit `$SYNAPSE_VAULT` both outrank it |
| `SYNAPSE_MCP_SURFACE` | `full` | `skeleton` \| `standard` \| `full` \| `orchestrator`, on stdio or HTTP |
| `SYNAPSE_MCP_HOST` / `BIND_ADDR` | `127.0.0.1` | HTTP listen address; explicit loopback/VPN only, wildcard refused |
| `SYNAPSE_MCP_PORT` | `3000` | HTTP listen port |
| `SYNAPSE_MCP_PATH` | `/mcp` | HTTP endpoint path |
| `SYNAPSE_MCP_PLUGINS` | _(none)_ | comma-separated plugin paths; on shared HTTP these are the only plugins and apply to every vault |
| `VAULT_USER` | _(git email)_ | canary name |

Full sink table and TUI notes: [[doc-runtime-wiring]].

## Related
[[doc-agent-memory]] — the memory/live-context tools these commands expose.

[[doc-runtime-wiring]] · [[doc-semantic-recall]] · [[doc-deployment-gate]] · [[doc-fork-and-extend]] · [[conventions]] · [[context-engine-guide]] · [[hub-synapse]]
