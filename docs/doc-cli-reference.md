---
id: doc-cli-reference
type: doc
title: CLI & command reference — every runnable command, env var, and runtime sink
tags:
  - type/doc
  - area/runtime
  - status/active
references_docs: ["[[conventions]]"]
related: ["[[hub-synapse]]"]
---

# CLI & command reference

Everything runnable, in one place — the canonical cheat-sheet the [README](../README.md) links to.
There are **two front-ends over the same engine** (`@eborjaa/synapse`): the **`synapse` CLI** /
shell agent commands (after `synapse install`), and direct `node lib/<tool>.mjs` during package
development. Vault resolves from `$SYNAPSE_VAULT` or `$PWD` (flat or nested layout — see
[[doc-fork-and-extend]]).

## A. Shell CLI

Source once (`synapse install --write` → `agents.sh`). Everything is reachable as `synapse <sub>`;
the `vault-*` names are maintained equals. Agent launchers stay top-level.

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

**Syntax:** `<agent> [<target>] [--profile lean|standard|fat] ["task"]`. A `hub-*` target auto-upgrades a
`lean` agent to `standard`; a bare profile word also works (`curator hub-finances fat`). Supplying a
**task** auto-routes through the semantic augment when the embedding index exists.

## B. `synapse` CLI (npm package)

```bash
synapse render agent-curator hub-finances --profile standard
synapse render --lint
synapse lint [--strict]
synapse migrate [--status]
synapse index
synapse views
synapse embeddings [--all]
synapse augment agent-curator hub-finances --profile standard --task "…"
synapse setup [--write]
synapse install [--write]
```

Legacy shims under `_meta/tools/*.mjs` in this template forward to `lib/` — prefer the `synapse` CLI.

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
| `SYNAPSE_VAULT` | _(cwd walk)_ | explicit vault root override |
| `VAULT_USER` | _(git email)_ | canary name |

Full sink table and TUI notes: [[doc-runtime-wiring]].

## Related
[[doc-runtime-wiring]] · [[doc-semantic-recall]] · [[doc-deployment-gate]] · [[doc-fork-and-extend]] · [[conventions]] · [[context-engine-guide]] · [[hub-synapse]]
