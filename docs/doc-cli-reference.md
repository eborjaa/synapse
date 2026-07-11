---
id: doc-cli-reference
type: doc
title: CLI & command reference — every runnable command, env var, and runtime sink
tags:
  - type/doc
  - area/runtime
  - status/active
references_docs: ["[[conventions]]"]
related: ["[[moc-synapse]]"]
---

# CLI & command reference

Everything runnable, in one place — the canonical cheat-sheet the [README](../README.md) links to.
There are **two front-ends over the same `_meta/tools/` scripts**: **`~/synapse/bin/*`** commands on PATH
(install once — they re-source the live scripts every call, no reinstall on update) and direct `node`
invocation. Vault resolves from `$PWD`; outside any vault → `synapse-vault` by default.

## A. Shell CLI

Source once (`agents.sh` via `install.mjs`), then call agents by name:

| Command | Does |
|---|---|
| `<agent> [<target>] [--profile lean\|standard\|fat] [--cli opencode\|claude\|cursor\|clip\|print] [--model <id>] [--auto\|bypass\|manual] ["task"]` | render briefing → hand to chosen runtime as **system context**; task is separate user prompt. e.g. `curator moc-finances --cli cursor --model claude-opus-4-8-thinking-high "rebuild summaries"` |
| `vault-agents` | list all agents + purpose + default profile |
| `vault-mocs` | list all MOC targets (the master + 7 domain hubs) |
| `vault-profiles` | explain `lean` / `standard` / `fat` (the context dial) |
| `vault-models [--cli opencode\|claude\|cursor] [--refresh]` | list models for a CLI (`--model` TAB-completes per `--cli`) |
| `vault-reload` | force re-source `agents.sh` (also auto-reloads when the file is edited) |
| `vault-bedrock on\|off\|status` | enable/disable AWS Bedrock via Cursor team-role; `status` lists raw `us.anthropic.*` IDs |

**Syntax:** `<agent> [<target>] [--profile lean|standard|fat] ["task"]`. A `moc-*` target auto-upgrades a
`lean` agent to `standard`; a bare profile word also works (`curator moc-finances fat`). Supplying a
**task** auto-routes through the semantic augment when the embedding index exists, so the briefing also
carries notes the typed graph never linked.

## The runtime is pluggable (`--cli` + `--model`)

OpenCode is the **default** sink, not the only one. The same rendered briefing can be handed to a
swappable runtime with `--cli` (or `export SYNAPSE_CLI=…`):

| Sink | Briefing delivery | Task | `--model` list from |
|---|---|---|---|
| `opencode` (default) | `--file` / `--prompt` | separate user message | `opencode models` |
| `claude` | `--append-system-prompt-file` + `--add-dir` vault | positional after `--` | aliases (`sonnet`, `opus`, …) |
| `cursor` | `.cursor/rules/.synapse-vault-briefing.mdc` (`alwaysApply`) | positional to `cursor-agent` | `cursor-agent models` + Bedrock IDs |
| `clip` | clipboard (+ task after `---`) | — | n/a |
| `print` | stdout | — | n/a |

`--model` / `-m` TAB-completes **per the `--cli` in the same command** (`vault-models --cli <name>`).
Permission modes: `--auto` (default), `--bypass`, `--manual` — mapped to each CLI's native flags.

Because the render + semantic pipeline is identical for every sink, you can maintain the **public
framework** with Claude Code or Cursor while a **private vault** stays on local OpenCode. Any host privacy
gate still applies ([[doc-deployment-gate]]).

## Runtime environment variables

| Variable | Default | Effect |
|---|---|---|
| `SYNAPSE_CLI` | `opencode` | default runtime sink (`opencode` \| `claude` \| `cursor` \| `clip` \| `print`) |
| `SYNAPSE_MODEL` | `ollama/qwen3.6-256k` | default model for `--cli opencode`; override per-call with `--model` |
| `SYNAPSE_PERM_MODE` | `auto` | default permission mode (`manual` \| `auto` \| `bypass`); legacy: `SYNAPSE_AUTO=0/1` |
| `SYNAPSE_CURSOR_MODEL` | `auto` | default for `--cli cursor`; falls back to `~/.cursor/cli-config.json` selected model, then last `--model` |
| `SYNAPSE_CURSOR_BEDROCK` | `off` | set `on` to opt into AWS Bedrock tenant IDs (`us.anthropic.*`); also: `vault-bedrock on` |
| `SYNAPSE_MODELS_TTL` | `3600` | cache TTL (seconds) for `vault-models` / TAB completion |
| `SYNAPSE_EMBED_MODEL` | `mxbai-embed-large` | the embedding model for semantic recall |
| `SYNAPSE_MIN_SIM` | `0.45` | similarity floor for semantic hits (tune per embed model) |
| `SYNAPSE_TUI` | _(auto)_ | `1` forces the OpenCode TUI; `0` forces one-shot `opencode run`. Auto: interactive terminal → TUI; no TTY (cron/pipes) → one-shot |
| `SYNAPSE_THINKING` | `1` | in one-shot mode, stream the model's reasoning as proof-of-life (a local model can sit silent 30–90s while it processes a multi-thousand-token briefing). Set `0` to print only the final answer |
| `VAULT_USER` | _(git email)_ | the name used in the nightly canary; falls back to `git config user.email`, then a generic default |

In an interactive terminal an agent opens the **OpenCode TUI** seeded with the briefing — native progress
spinner + token counter, and a live session to keep working with the agent. With no TTY it falls back to
one-shot `opencode run`.

## B. Direct `node` (no shell setup)

Drive the engine scripts yourself:

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

## Related
[[doc-runtime-wiring]] · [[doc-semantic-recall]] · [[doc-deployment-gate]] · [[conventions]] · [[context-engine-guide]] · [[moc-synapse]]
